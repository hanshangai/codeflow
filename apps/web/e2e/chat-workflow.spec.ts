import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChatWorkflowSnapshot, ChatWorkflowView } from "@codeflowai/shared";

function createSnapshot(): ChatWorkflowSnapshot {
  const task = { id: "task-e2e", workspaceId: "workspace_chat_core_e2e", threadId: "thread-e2e", sourceTurnId: "turn-e2e", initiatorUserId: "chat-core-e2e-user", version: 1, state: "recommended", title: "订单批量导出与管理员权限验证", goal: "为管理员增加订单批量导出", context: "需求上下文", acceptanceCriteria: ["管理员能导出订单，普通成员无法导出"], rationale: "该任务包含权限、接口、界面和验证阶段。", workflow: { id: "workflow-e2e", name: "标准开发工作流", nodes: [{ id: "dev", type: "role", label: "实现与验证" }], edges: [], version: 1 }, assetHash: "hash", proposalId: null, intakeId: "intake-e2e", instanceId: null, acceptedResultVersion: null, acceptedBy: null, acceptedAt: null, rework: null, createdAt: 1, updatedAt: 1 } as unknown as ChatWorkflowView["task"];
  return { recommendationEnabled: true, tasks: [{ task, status: null, resultVersion: null, stages: [{ nodeId: "dev", label: "实现与验证", status: "pending", error: null }], todos: [], artifacts: [], checks: [], canAccept: true, accepted: false, updates: [], acceptance: [] }] };
}

async function setup(page: Page) {
  const snapshot = createSnapshot();
  const actions: Record<string, unknown>[] = [];
  const naturalRequests: Record<string, unknown>[] = [];
  const ordinarySends: Record<string, unknown>[] = [];
  const deletes: Record<string, unknown>[] = [];
  await page.route("**/api/orch/chat/**", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = new URL(route.request().url()).pathname.split("/").pop();
    const view = snapshot.tasks[0]!;
    if (endpoint === "settings") snapshot.recommendationEnabled = Boolean(body.enabled);
    if (endpoint === "delete") {
      deletes.push(body);
      // 必须真的把卡片从快照摘掉：面板每 4 秒按 get 刷新，留在快照里的卡片会「复活」。
      snapshot.tasks = snapshot.tasks.filter(item => item.task.id !== body.taskId);
      return route.fulfill({ json: { ok: true, removed: { taskId: body.taskId } } });
    }
    if (endpoint === "action") {
      actions.push(body);
      if (Number(body.expectedVersion) !== view.task.version) return route.fulfill({ json: { ok: false, code: "CONFLICT", message: "卡片已更新" }, status: 409 });
      view.task.version++;
      if (body.action === "start") {
        view.task.state = "linked"; view.task.instanceId = "instance-e2e"; view.status = "waiting-approval"; view.resultVersion = "result-1";
        view.todos = [{ nodeId: "dev", label: "实现与验证", version: "node-1", status: "waiting-approval", summary: "已完成导出接口与权限检查。", question: "请审阅导出结果与权限验证。", actions: [{ action: "approve", label: "审核通过", effect: "通过当前节点并继续流程" }], branches: [] }];
        view.artifacts = [{ id: "artifact-e2e", nodeId: "dev", title: "设计方案节点（SOLUTION） 输出 v1", version: 1, summary: "扫码登录方案" }];
      }
      if (body.action === "feedback") { view.todos = []; view.status = "completed"; view.resultVersion = "result-2"; view.acceptance = [{ text: "权限测试", status: "passed", evidence: "验证通过" }]; }
      if (body.action === "accept") view.accepted = true;
      if (body.action === "dismiss") {
        view.task.state = "dismissed";
        view.task.continuationQueueItemId = "queue-continuation-e2e";
        view.continuation = { queueItemId: "queue-continuation-e2e", status: "pending", paused: false, failureReason: null };
      }
      return route.fulfill({ json: { ok: true, view } });
    }
    if (endpoint === "natural") {
      naturalRequests.push(body);
      const text = String(body.text ?? "").trim();
      const inputTodos = view.todos.filter(todo => todo.actions.some(action => action.action === "resume_with_input"));
      if (inputTodos.length === 1 && text) {
        view.todos = [];
        view.status = "completed";
        view.resultVersion = "result-after-input";
        return route.fulfill({ json: { ok: true, handled: true, view, action: "feedback", feedbackAction: "resume_with_input" } });
      }
      // 前缀式批准：与上一条并列，只做服务端解析器的最小复刻（前缀判定与意见剥离都不在这里验证）。
      const approvalTodos = view.todos.filter(todo => todo.actions.some(action => action.action === "approve"));
      if (approvalTodos.length === 1 && /^(?:同意方案|审核通过|通过审核|同意)[：:]/u.test(text)) {
        view.todos = [];
        view.status = "completed";
        view.resultVersion = "result-after-approval";
        return route.fulfill({ json: { ok: true, handled: true, view, action: "feedback", feedbackAction: "approve" } });
      }
      return route.fulfill({ json: { ok: true, handled: false } });
    }
    return route.fulfill({ json: { ok: true, ...snapshot } });
  });
  await page.route("**/api/threads/send", route => {
    ordinarySends.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 500, json: { ok: false, code: "UNEXPECTED_CHAT_SEND", message: "工作流意见不应进入普通消息接口" } });
  });
  // 保留 mock 真实列表，只补一个活跃工作流态，验证会话行标签由列表响应驱动
  await page.route("**/api/threads?**", async route => {
    const response = await route.fetch();
    const body = await response.json() as { threads?: Array<{ id: string }> };
    const firstThreadId = String(body.threads?.[0]?.id ?? "");
    return route.fulfill({
      response,
      json: {
        ...body,
        ...(firstThreadId
          ? { workflowByThreadId: { [firstThreadId]: { status: "waiting-approval", instanceId: "instance-e2e", taskId: "task-e2e" } } }
          : {}),
      },
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("config", JSON.stringify({ serverWsOrigin: "ws://127.0.0.1:39290", authMode: "account", accountRole: "enterprise_admin", sessionToken: "chat-core-e2e-session", sessionExpiresAt: Date.now() + 3600000, homePath: "/chat",
      userSummary: { userId: "chat-core-e2e-user", email: "chat-core-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" } }));
  });
  await page.goto("/chat");
  await page.getByText("+ 新建").click();
  await page.getByRole("dialog").getByPlaceholder(/例如：修复登录页样式/).fill("工作流会话");
  await page.getByRole("dialog").getByRole("button", { name: /确\s*定/ }).click();
  await expect(page.getByText("工作流会话").first()).toBeVisible();
  // 任务列表可在用例中被置空，仅在非空场景断言面板可见。
  if (snapshot.tasks.length) await expect(page.locator(".chat-workflow")).toBeVisible({ timeout: 15000 });
  return { snapshot, actions, naturalRequests, ordinarySends, deletes };
}

/** 主动触发一次面板刷新；推荐态使用 30 秒兜底轮询，用例时限内不会自动反映快照修改。 */
async function refreshWorkflowPanel(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

/** 点删除入口并在 popconfirm 里确认；popconfirm 是删除不可恢复的唯一确认关口。 */
async function confirmCardDeletion(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: "删除", exact: true }).click();
  const popconfirm = page.locator(".ant-popover:visible");
  await expect(popconfirm).toContainText("删除后不可恢复");
  await popconfirm.locator("button").last().click();
}

/** 用显式释放控制慢请求，避免用固定延时判断加载状态。 */
function createReadGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** 只模拟节点详情读取；实例、正文、事件和历史版本可以分别暂停。 */
async function setupNodeDetailReads(page: Page, failInstanceOnce = false) {
  const instanceRead = createReadGate();
  const bodyRead = createReadGate();
  const eventsRead = createReadGate();
  const historyRead = createReadGate();
  const artifacts = [2, 1].map(version => ({
    id: version === 2 ? "artifact-e2e" : "artifact-history", instanceId: "instance-e2e", nodeId: "dev",
    kind: "report", version, title: "交付结果", status: "approved", payloadMode: "file",
    contentJson: JSON.stringify({ mode: "file", file: { path: "report.md", content: `# 已加载第 ${version} 版\n\n交付正文。` } }),
    createdAt: version, updatedAt: version,
  }));
  const instance = {
    id: "instance-e2e", workspaceId: "workspace_chat_core_e2e", status: "completed", workflowId: "workflow-e2e", proposalId: "proposal-e2e",
    intakeSnapshot: { id: "intake-e2e", title: "详情加载验证", taskType: "feature", triggerMode: "manual" },
    workflowSnapshot: createSnapshot().tasks[0]!.task.workflow,
    nodeStates: { dev: { nodeId: "dev", status: "completed", retryCount: 0, outputArtifactIds: ["artifact-e2e"], startedAt: 1, completedAt: 2 } },
    artifactIndex: { dev: artifacts.map(artifact => artifact.id) }, createdAt: 1, updatedAt: 2,
  };
  let instanceRequests = 0;
  let fileRequests = 0;
  let eventResponses = 0;
  await page.route("**/api/orch/instances/get", async route => {
    instanceRequests++;
    if (failInstanceOnce && instanceRequests === 1) {
      return route.fulfill({ json: { ok: false, code: "DETAIL_FIXTURE_FAILED", message: "节点详情读取失败", details: { requestId: "detail-fixture" } } });
    }
    await instanceRead.promise;
    return route.fulfill({ json: { ok: true, instance } });
  });
  await page.route("**/api/orch/artifacts/list", route => route.fulfill({ json: { ok: true, artifacts: artifacts.map(artifact => ({ ...artifact, contentJson: "" })) } }));
  await page.route("**/api/orch/artifacts/get", async route => {
    const { artifactId } = route.request().postDataJSON() as { artifactId: string };
    await (artifactId === "artifact-e2e" ? bodyRead : historyRead).promise;
    return route.fulfill({ json: { ok: true, artifact: artifacts.find(artifact => artifact.id === artifactId) } });
  });
  await page.route("**/api/orch/artifact-files/list", route => {
    if (route.request().postDataJSON().artifactId === "artifact-e2e") fileRequests++;
    return route.fulfill({ json: { ok: true, files: [], fields: [] } });
  });
  await page.route("**/api/orch/events/list", async route => {
    await eventsRead.promise;
    await route.fulfill({ json: { ok: true, events: [] } });
    eventResponses++;
  });
  await page.route("**/api/orch/prompt-snapshots/list", route => route.fulfill({ json: { ok: true, snapshots: [] } }));
  return {
    instanceRead, bodyRead, eventsRead, historyRead,
    counts: () => ({ instanceRequests, fileRequests, eventResponses }),
    releaseAll: () => { instanceRead.release(); bodyRead.release(); eventsRead.release(); historyRead.release(); },
  };
}

test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:39290/api/test/reset"); });

test("节点详情立即打开，慢目录不阻塞正文且版本对比保持高度", async ({ page }) => {
  const reads = await setupNodeDetailReads(page);
  try {
    await setup(page);
    const panel = page.locator(".chat-workflow");
    await panel.getByRole("button", { name: "确认使用并启动" }).click();
    await panel.locator(".chat-workflow__stage").first().click();
    const modal = page.locator(".chat-workflow__node-detail-modal .ant-modal-content");
    await expect(modal.getByRole("status")).toContainText("正在加载节点详情");
    const initialHeight = await modal.locator(".chat-workflow__node-detail").evaluate(el => el.clientHeight);
    reads.instanceRead.release();
    const preview = modal.locator(".node-detail__preview-frame--result");
    await expect(preview.getByRole("status")).toBeVisible();
    await expect(preview).not.toContainText("没有可预览正文");
    reads.bodyRead.release();
    await expect(preview).toContainText("已加载第 2 版");
    expect(reads.counts().eventResponses).toBe(0);
    reads.eventsRead.release();
    await expect.poll(() => reads.counts().eventResponses).toBe(1);
    await expect(modal.locator(".node-detail__preview-toggle").first()).toBeVisible();
    expect(reads.counts().fileRequests).toBe(1);
    expect(await modal.locator(".chat-workflow__node-detail").evaluate(el => el.clientHeight)).toBe(initialHeight);

    await modal.getByRole("button", { name: "对比版本", exact: true }).click();
    const compare = page.locator(".node-detail__compare-modal");
    await expect(compare.getByRole("status")).toBeVisible();
    const loadingHeight = await compare.evaluate(el => el.clientHeight);
    reads.historyRead.release();
    await expect(compare.locator(".node-detail__compare-diff")).toBeVisible();
    expect(await compare.evaluate(el => el.clientHeight)).toBe(loadingHeight);
    expect(reads.counts().fileRequests).toBe(1);
  } finally { reads.releaseAll(); }
});

test("节点详情读取失败可重试，关闭后迟到结果不重新打开弹框", async ({ page }) => {
  const reads = await setupNodeDetailReads(page, true);
  try {
    await setup(page);
    const panel = page.locator(".chat-workflow");
    await panel.getByRole("button", { name: "确认使用并启动" }).click();
    await panel.locator(".chat-workflow__stage").first().click();
    const modal = page.locator(".chat-workflow__node-detail-modal .ant-modal-content");
    await expect(modal.getByRole("alert")).toContainText("节点详情读取失败");
    await modal.getByRole("button", { name: /重\s*试/ }).click();
    await expect(modal.getByRole("status")).toBeVisible();
    await modal.locator(".ant-modal-close").click();
    const response = page.waitForResponse(result => result.url().endsWith("/api/orch/instances/get"));
    reads.releaseAll();
    await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(modal).toBeHidden();
    await expect.poll(() => reads.counts().instanceRequests).toBe(2);
  } finally { reads.releaseAll(); }
});

test("workflow recommendation, node approval and final acceptance remain distinct", async ({ page }) => {
  const { actions } = await setup(page);
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await expect(panel.getByText("请审阅导出结果与权限验证。")).toBeVisible();
  // 唯一待审核待办改由会话框承担：内联 textarea 不渲染，提示与动作按钮留在卡片上。
  await expect(panel.getByPlaceholder("审核意见或补充内容")).toHaveCount(0);
  await expect(panel.getByText("可在下方会话框输入")).toBeVisible();
  await panel.getByRole("button", { name: "审核通过", exact: true }).click();
  await expect(panel.getByText("执行完成，待验收")).toBeVisible();
  await panel.getByRole("button", { name: "最终验收通过" }).click();
  await expect(panel.getByText("验收通过", { exact: true })).toBeVisible();
  expect(actions.map(a => a.action)).toEqual(["start", "feedback", "accept"]);
  expect(actions[1]?.nodeVersion).toBe("node-1");
  await page.screenshot({ path: "../../.tmp/chat-workflow-desktop.png", fullPage: true });
});

test("a full review opinion in the conversation composer resumes the only waiting-input todo", async ({ page }) => {
  const { snapshot, naturalRequests, ordinarySends } = await setup(page);
  const view = snapshot.tasks[0]!;
  view.task.state = "linked";
  view.task.instanceId = "instance-e2e";
  view.status = "waiting-feedback";
  view.resultVersion = "result-waiting-input";
  view.todos = [{
    nodeId: "solution", label: "方案设计", version: "solution-v1", status: "waiting-feedback",
    summary: "扫码登录方案需要补充环境边界。", question: "请补充生产域名和本地测试策略。",
    actions: [{ action: "resume_with_input", label: "补充并继续", effect: "提交补充内容并继续执行" }], branches: [],
  }];
  const panel = page.locator(".chat-workflow");
  await refreshWorkflowPanel(page);
  await expect(panel.getByText("请补充生产域名和本地测试策略。")).toBeVisible({ timeout: 15000 });
  // 唯一待补充待办改由会话框承担：内联输入与其动作按钮不渲染，只留提示与流程级的「提出修改」。
  await expect(panel.getByPlaceholder("审核意见或补充内容")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "补充并继续" })).toHaveCount(0);
  await expect(panel.getByText("请在下方会话框")).toBeVisible();
  await expect(panel.getByRole("button", { name: "提出修改" })).toBeVisible();

  const opinion = "生产回调域使用 codeflow.hanshangai.com；本地测试环境暂不启用扫码登录。";
  await page.locator(".composer__textarea").fill(opinion);
  await page.locator(".composer__send-btn").click();

  await expect(page.getByText("审核意见已提交到工作流待办", { exact: true })).toBeVisible();
  await refreshWorkflowPanel(page);
  await expect(panel.getByText("执行完成，待验收")).toBeVisible();
  expect(naturalRequests).toHaveLength(1);
  expect(naturalRequests[0]?.text).toBe(opinion);
  expect(ordinarySends).toHaveLength(0);
  await expect(page.locator(".composer__textarea")).toHaveValue("");
});

test("a prefixed approval in the conversation composer approves the only pending review", async ({ page }) => {
  const { naturalRequests, ordinarySends } = await setup(page);
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await expect(panel.getByText("可在下方会话框输入")).toBeVisible();

  const opinion = "审核通过：权限验证符合要求。";
  await page.locator(".composer__textarea").fill(opinion);
  await page.locator(".composer__send-btn").click();

  await expect(page.getByText("审核意见已提交到工作流待办", { exact: true })).toBeVisible();
  await refreshWorkflowPanel(page);
  await expect(panel.getByText("执行完成，待验收")).toBeVisible();
  // mock 只断言请求原文：意见是否真的剥离并随审批下传由解析器/store 单测负责。
  expect(naturalRequests).toHaveLength(1);
  expect(naturalRequests[0]?.text).toBe(opinion);
  expect(ordinarySends).toHaveLength(0);
  await expect(page.locator(".composer__textarea")).toHaveValue("");
});

test("普通文本在等待审核期间被拦下且草稿保留", async ({ page }) => {
  const { naturalRequests, ordinarySends } = await setup(page);
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await expect(panel.getByText("可在下方会话框输入")).toBeVisible();

  const chat = "帮我看看这个方案还有没有问题";
  await page.locator(".composer__textarea").fill(chat);
  await page.locator(".composer__send-btn").click();

  await expect(page.getByText("当前节点等待审核，这条消息未发送", { exact: false })).toBeVisible();
  // 抛错路径不得清空草稿，也不得把正文流入 AI 对话或 /natural。
  await expect(page.locator(".composer__textarea")).toHaveValue(chat);
  expect(naturalRequests).toHaveLength(0);
  expect(ordinarySends).toHaveLength(0);
});

test("存在多个待补充待办时内联控件保留，不被会话框接管", async ({ page }) => {
  const { snapshot } = await setup(page);
  const view = snapshot.tasks[0]!;
  view.task.state = "linked";
  view.task.instanceId = "instance-e2e";
  view.status = "waiting-feedback";
  view.resultVersion = "result-waiting-input-multi";
  const inputTodo = (nodeId: string) => ({
    nodeId, label: "方案设计", version: `${nodeId}-v1`, status: "waiting-feedback", summary: "", question: `请补充 ${nodeId} 的边界。`,
    actions: [{ action: "resume_with_input" as const, label: "补充并继续", effect: "提交补充内容并继续执行" }], branches: [] as Array<{ nodeId: string; label: string }>,
  });
  view.todos = [inputTodo("solution-a"), inputTodo("solution-b")];
  await refreshWorkflowPanel(page);
  const panel = page.locator(".chat-workflow");
  await expect(panel.getByText("请补充 solution-a 的边界。")).toBeVisible({ timeout: 15000 });
  // 两个待办都在：裸文本无法指向其中之一，必须保留内联输入与其动作按钮。
  await expect(panel.getByPlaceholder("审核意见或补充内容")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "补充并继续" })).toHaveCount(2);
  await expect(panel.getByText("请在下方会话框")).toHaveCount(0);
});

test("会话列表行显示活跃工作流标签，且不复用工作流面板词表", async ({ page }) => {
  await setup(page);
  const row = page.locator(".thread-list__item").filter({ hasText: "工作流会话" }).first();
  const badge = row.locator(".thread-list__status-badge");
  await expect(badge).toHaveText("待确认");
  await expect(badge).toHaveClass(/thread-list__status-badge--info/);

  // 同一会话的工作流面板在该状态下用的是「待审核」，列表行必须是列表自己的词汇
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await expect(panel).toContainText("待审核");
  await expect(badge).toHaveText("待确认");
});

test("empty workflow snapshot hides the panel until a task appears", async ({ page }) => {
  const { snapshot } = await setup(page);
  const panel = page.locator(".chat-workflow");
  snapshot.tasks = [];
  await refreshWorkflowPanel(page);
  await expect(panel).toHaveCount(0, { timeout: 15000 });
});

test("declining workflow shows queued continuation until the conversation starts", async ({ page }) => {
  const { snapshot, actions } = await setup(page);
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "本次直接在会话处理", exact: true }).click();
  await expect(panel.getByText("已交回当前会话，等待前序消息完成后执行。")).toBeVisible();
  expect(actions.map(action => action.action)).toEqual(["dismiss"]);
  snapshot.tasks[0]!.continuation!.paused = true;
  await refreshWorkflowPanel(page);
  await expect(panel.getByText("已交回当前会话，消息队列已暂停，请在会话队列中继续发送。")).toBeVisible({ timeout: 15000 });
  await expect(panel.getByRole("button", { name: "继续在会话处理", exact: true })).toHaveCount(0);
  snapshot.tasks[0]!.continuation!.status = "sent";
  await refreshWorkflowPanel(page);
  await expect(panel).toHaveCount(0, { timeout: 15000 });
});

test("deleting an unstarted recommendation removes the card for good", async ({ page }) => {
  const { snapshot, deletes } = await setup(page);
  const panel = page.locator(".chat-workflow");
  await expect(panel.getByRole("button", { name: "确认使用并启动" })).toBeVisible({ timeout: 15000 });

  await confirmCardDeletion(page, panel);

  // 最后一张卡被删掉后整块面板消失（既有行为），且删除请求指向该卡。
  await expect(panel).toHaveCount(0, { timeout: 15000 });
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.taskId).toBe("task-e2e");
  expect(snapshot.tasks).toHaveLength(0);
});

test("deleting a card handed back to the conversation also removes it from the panel", async ({ page }) => {
  const { snapshot, deletes } = await setup(page);
  const taskId = snapshot.tasks[0]!.task.id;
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "本次直接在会话处理", exact: true }).click();
  await expect(panel.getByText("已交回当前会话，等待前序消息完成后执行。")).toBeVisible();

  await confirmCardDeletion(page, panel);

  await expect(panel).toHaveCount(0, { timeout: 15000 });
  expect(deletes).toHaveLength(1);
  // 待发续跑项由服务端在同一事务里取消，前端只需保证删除请求指向这张卡。
  expect(deletes[0]?.taskId).toBe(taskId);
});

test("previously dismissed recommendations expose an explicit recovery action", async ({ page }) => {
  const { snapshot, actions } = await setup(page);
  snapshot.tasks[0]!.task.state = "dismissed";
  await refreshWorkflowPanel(page);
  const panel = page.locator(".chat-workflow");
  await expect(panel.getByText("已选择在当前会话处理，但尚未提交续跑任务。点击下方按钮继续。")).toBeVisible({ timeout: 15000 });
  expect(actions.length).toBe(0);
  await panel.getByRole("button", { name: "继续在会话处理", exact: true }).click();
  await expect(panel.getByText("已交回当前会话，等待前序消息完成后执行。")).toBeVisible();
  expect(actions.map(action => action.action)).toEqual(["dismiss"]);
});

test("workflow artifact preview renders the parsed file instead of raw contentJson", async ({ page }) => {
  await page.route("**/api/orch/artifacts/get", route => route.fulfill({ json: { ok: true, artifact: { id: "artifact-e2e", instanceId: "instance-e2e", nodeId: "dev", kind: "design", version: 1, title: "设计方案节点（SOLUTION） 输出 v1", status: "approved", payloadMode: "file", contentJson: JSON.stringify({ mode: "file", file: { path: "docs/solution.md", content: "# 扫码登录方案\n\n正文说明。" } }), createdAt: 1, updatedAt: 1 } } }));
  await page.route("**/api/orch/artifact-files/list", route => route.fulfill({ json: { ok: true, files: [] } }));
  await setup(page);
  const panel = page.locator(".chat-workflow");
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await panel.getByRole("button", { name: /设计方案节点/ }).click();
  const modal = page.getByRole("dialog").filter({ hasText: "扫码登录方案" });
  await expect(modal.getByRole("heading", { name: "扫码登录方案" })).toBeVisible();
  await expect(modal).not.toContainText('"mode"');
  // 全屏：宽度铺满视口，预览容器高度明显超过非全屏的 70vh（视口尺寸以运行时为准）。
  const previewModal = page.locator(".chat-workflow__preview-modal .ant-modal");
  const viewport = page.viewportSize()!;
  await modal.getByRole("button", { name: "全屏查看产物预览弹框" }).click();
  await expect(modal.getByRole("button", { name: "还原产物预览弹框" })).toBeVisible();
  await expect.poll(async () => (await previewModal.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(viewport.width - 1);
  await expect.poll(async () => (await page.locator(".chat-workflow__preview").boundingBox())?.height ?? 0).toBeGreaterThan(viewport.height * 0.7 + 60);
  // 还原回到固定的 800px 宽度。
  await modal.getByRole("button", { name: "还原产物预览弹框" }).click();
  await expect.poll(async () => (await previewModal.boundingBox())?.width ?? 0).toBeLessThanOrEqual(801);
  // 全屏下 Esc 直接关闭弹框，不退全屏、也不被拦截。
  await modal.getByRole("button", { name: "全屏查看产物预览弹框" }).click();
  await expect(modal.getByRole("button", { name: "还原产物预览弹框" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-workflow__preview-modal")).toBeHidden();
});

test("同一节点的同一产物只显示最新版本，不同名称的产物各自保留", async ({ page }) => {
  const { snapshot } = await setup(page);
  const view = snapshot.tasks[0]!;
  view.task.state = "linked";
  view.task.instanceId = "instance-e2e";
  view.artifacts = [
    { id: "artifact-solution-v1", title: "方案设计节点（SOLUTION） 输出 v1", nodeId: "solution", version: 1, summary: "" },
    { id: "artifact-solution-v2", title: "方案设计节点（SOLUTION） 输出 v2", nodeId: "solution", version: 2, summary: "" },
    { id: "artifact-dev-v1", title: "全栈开发节点（FULLSTACK-DEV） 输出 v1", nodeId: "dev", version: 1, summary: "" },
  ];
  await refreshWorkflowPanel(page);
  const panel = page.locator(".chat-workflow");
  await expect(panel.getByRole("button", { name: "方案设计节点（SOLUTION） 输出 v2" })).toBeVisible({ timeout: 15000 });
  await expect(panel.locator(".chat-workflow__artifacts button").filter({ hasText: "方案设计节点（SOLUTION）" })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "全栈开发节点（FULLSTACK-DEV） 输出 v1" })).toBeVisible();
});

test("recommendation preference survives reload and long titles fit a mobile viewport", async ({ page }) => {
  const { snapshot } = await setup(page);
  const toggle = page.getByRole("button", { name: "WorkFlow" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(snapshot.recommendationEnabled).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "WorkFlow" })).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator(".chat-workflow");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认使用并启动" })).toBeVisible();
  const overflow = await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "../../.tmp/chat-workflow-mobile.png", fullPage: true });
});

test("门禁未过的待办在卡片上给出忽略入口，并经危险确认后才提交", async ({ page }) => {
  const { snapshot, actions } = await setup(page);
  const view = snapshot.tasks[0]!;
  const panel = page.locator(".chat-workflow");
  // 待办只在卡片进入运行态后渲染，先启动再切到门禁未过状态。
  await panel.getByRole("button", { name: "确认使用并启动" }).click();
  await expect(panel.getByRole("button", { name: "审核通过", exact: true })).toBeVisible();
  view.status = "waiting-feedback";
  view.todos = [{
    nodeId: "dev",
    label: "实现与验证",
    version: "node-1",
    status: "waiting-feedback",
    summary: "",
    question: "门禁未通过: e2e-runtime-precheck(正则不匹配: 运行态前置)",
    actions: [
      { action: "reevaluate_gates", label: "重新评估门禁", effect: "按当前结果重新判定门禁，不改动结果内容" },
      { action: "override", label: "忽略门禁继续", effect: "忽略门禁未通过结果，把节点标记为通过并继续后续流程" },
      { action: "resume_with_input", label: "补充并继续", effect: "将补充内容交给当前节点继续处理" },
    ],
    branches: [],
  }];

  await refreshWorkflowPanel(page);
  await expect(panel.getByRole("button", { name: "重新评估门禁" })).toBeVisible({ timeout: 15_000 });

  // 直接点击不提交：必须先经过「确认忽略门禁」这一道危险确认（此前只剩启动那一次提交）。
  const submitted = actions.length;
  await panel.getByRole("button", { name: "忽略门禁继续" }).click();
  const confirm = page.locator(".ant-popover:visible");
  await expect(confirm).toContainText("确认忽略门禁");
  expect(actions.length).toBe(submitted);
  await confirm.locator("button").last().click();

  await expect.poll(() => actions.length).toBe(submitted + 1);
  expect(actions.at(-1)?.feedbackAction).toBe("override");
  expect(actions.at(-1)?.nodeId).toBe("dev");
});

test("过程块折叠时不渲染条目，展开后才加载", async ({ page }) => {
  // 注入两条工具调用，构成一个「过程」批；未展开前条目不应进入 DOM。
  await page.route("**/api/threads/load", async (route) => {
    const request = route.request().postDataJSON() as { threadId?: string };
    const threadId = String(request.threadId ?? "");
    const ts = Date.now();
    let seq = 1_000;
    const event = (type: string, payload: Record<string, unknown>) => ({
      schema: 1, seq: seq++, ts, workspaceId: "workspace_chat_core_e2e", threadId, engine: "codex", type, payload,
    });
    await route.fulfill({
      json: {
        ok: true,
        thread: { id: threadId, title: "工作流会话", workspaceId: "workspace_chat_core_e2e", engine: "codex", sessionId: null, threadType: "chat", createdAt: ts, updatedAt: ts },
        events: [
          event("item.userMessage.created", { itemId: "user-1", text: "跑两条命令" }),
          event("item.tool.started", { itemId: "tool-1", toolName: "commandExecution", input: "git status" }),
          event("item.tool.completed", { itemId: "tool-1", toolName: "commandExecution", output: "clean", durationMs: 120 }),
          event("item.tool.started", { itemId: "tool-2", toolName: "commandExecution", input: "ls -la" }),
          event("item.tool.completed", { itemId: "tool-2", toolName: "commandExecution", output: "ok", durationMs: 80 }),
          event("item.agentMessage.completed", { itemId: "agent-1", engineMessageId: "engine-1", text: "已跑完", revision: 1 }),
        ],
      },
    });
  });
  await setup(page);

  const batch = page.locator(".msg--batch").first();
  await expect(batch).toBeVisible();

  // 折叠态：摘要照常给出条数与预览，但内部条目不渲染。
  await expect(batch.locator(".msg__summary-preview")).toBeVisible();
  await expect(batch.locator(".msg__summary-row")).toContainText("2 条");
  await expect(batch.locator("> .msg__batch-list")).toHaveCount(0);

  await batch.locator("> .msg__summary-row").click();
  await expect(batch.locator("> .msg__batch-list")).toBeVisible();
  await expect(batch.locator("> .msg__batch-list")).toContainText("commandExecution");

  // 收起后保留已渲染内容：再次展开不重新挂载。
  await batch.locator("> .msg__summary-row").click();
  await expect(batch.locator("> .msg__batch-list")).toHaveCount(1);
});

test("node box content stays horizontally centred inside its frame", async ({ page }) => {
  await setup(page);
  const stage = page.locator(".chat-workflow__stage").first();
  await expect(stage).toBeVisible();
  // 图标+标题成组居中、状态行同宽居中：两者的中心都必须落在框中心。
  const geometry = await stage.evaluate(node => {
    const box = node.getBoundingClientRect();
    const head = node.querySelector(".chat-workflow__stage-head")!.getBoundingClientRect();
    const status = node.querySelector(".chat-workflow__stage-status")!.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      boxCenter: box.left + box.width / 2,
      headCenter: head.left + head.width / 2,
      statusCenter: status.left + status.width / 2,
      statusWidth: status.width,
      alignItems: style.alignItems,
      textAlign: style.textAlign,
    };
  });
  expect(geometry.alignItems).toBe("center");
  expect(geometry.textAlign).toBe("center");
  expect(Math.abs(geometry.headCenter - geometry.boxCenter)).toBeLessThanOrEqual(1);
  if (geometry.statusWidth > 0) {
    expect(Math.abs(geometry.statusCenter - geometry.boxCenter)).toBeLessThanOrEqual(1);
  }

  // 长标题（真实场景如「TDD 开发（红绿重构）」）仍要成组居中，且只截断、不撑破节点框。
  await stage.locator(".chat-workflow__stage-label").evaluate(el => { el.textContent = "TDD 开发（红绿重构）与回归验证"; });
  const long = await stage.evaluate(node => {
    const box = node.getBoundingClientRect();
    const head = node.querySelector(".chat-workflow__stage-head")!.getBoundingClientRect();
    const label = node.querySelector(".chat-workflow__stage-label")!;
    return {
      boxLeft: box.left,
      boxRight: box.right,
      boxCenter: box.left + box.width / 2,
      headLeft: head.left,
      headRight: head.right,
      headCenter: head.left + head.width / 2,
      truncated: label.scrollWidth > label.clientWidth,
    };
  });
  expect(Math.abs(long.headCenter - long.boxCenter)).toBeLessThanOrEqual(1);
  expect(long.headLeft).toBeGreaterThanOrEqual(long.boxLeft - 0.5);
  expect(long.headRight).toBeLessThanOrEqual(long.boxRight + 0.5);
  expect(long.truncated).toBe(true);
});
