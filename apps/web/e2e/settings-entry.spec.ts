import { expect, test, type Page, type Response, type Route } from "@playwright/test";
import type { ScheduledTask } from "@codeflowai/shared";
import type { useConfigStore } from "../src/store/config";

/** 使用真实面板和 Pinia，仅替换可信 preload 数据边界。 */
async function installLocalTaskFixture(page: Page, active = true): Promise<void> {
  await page.route("**/__local-task-fixture", (route) => route.fulfill({ contentType: "text/html", body: `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0"><div id="fixture" style="height:100dvh;padding:16px;box-sizing:border-box"></div>
    <script type="module">
      import { createApp, h, ref } from '/node_modules/.vite/deps/vue.js';
      import { createPinia } from '/node_modules/.vite/deps/pinia.js';
      import Antd, { ConfigProvider, theme } from '/node_modules/.vite/deps/ant-design-vue.js';
      import Panel from '/src/features/admin/components/AdminScheduledTasksPanel.vue';
      import { useConfigStore } from '/src/store/config.ts';
      import '/src/styles.css';
      import '/node_modules/ant-design-vue/dist/reset.css';
      const task = { id:'local-task', source:'local', clientId:'local', deviceId:'device', workspaceScope:{scopeType:'local_workspace',scopeId:'local:ws'},
        revision:4, deletedAt:null, createdAt:1, updatedAt:1, name:'本机流程',description:'原说明',taskType:'workflow',cronExpr:'0 9 * * *',timezone:'Asia/Shanghai',enabled:true,
        timeoutMs:60001,concurrencyPolicy:'queue_one',missedPolicy:'run_once_on_reconnect',payload:{workflowId:'missing-flow',contextWorkspaceId:'local:ws',
        workflowVersionPolicy:null,intake:{goal:'原目标',acceptanceCriteria:['保留验收']},interactionMode:'autonomous',runMode:null,approvalMode:null,skipWhenPreviousInstanceStatuses:['failed']} };
      window.fixture = { active:ref(${active}), source:ref('local'), items:[task], total:41, requests:[], conflict:false, pending:false, deleted:false, release:null };
      window.codeflowDesktop = { getState:async()=>({status:'ready',requestId:'fixture',releaseId:null,errorCode:null}),onEvent:()=>()=>{},openWindow:async()=>{},exit:async()=>{},
        request:async(request)=>{ const f=window.fixture; request=structuredClone(request); f.requests.push(request); const b=request.body||{};
          if(request.method==='scheduledTasks.local.list') {
            const response={status:200,body:{ok:true,items:f.items.slice(b.offset||0,(b.offset||0)+(b.limit||20)),total:f.total}};
            if(f.deferList) await new Promise(resolve=>f.releaseList=resolve);
            else if(f.pending) await new Promise(resolve=>f.release=resolve);
            return response;
          }
          if(request.method==='workspaces.list') return {status:200,body:{ok:true,workspaces:[{id:'local:ws',title:'本机工作区',path:'/local',createdAt:1,updatedAt:1},{id:'remote:ws',title:'异机',path:'/remote',createdAt:1,updatedAt:1}]}};
          if(request.method==='orch.workflows.list') return {status:200,body:{ok:true,workflows:[]}};
          if(request.method==='scheduledTasks.local.runs') return {status:200,body:{ok:true,items:[{id:'run',taskId:'local-task',taskNameSnapshot:'已删除名称快照',configRevision:4,scheduledAt:1,status:'success',workflowInstanceId:'instance',summary:'已受理'}],total:41}};
          if(request.method==='scheduledTasks.local.cronPreview') {if(f.pending) await new Promise(resolve=>f.release=resolve);return {status:200,body:{ok:true,valid:true,nextRunAts:[123]}};}
          if(f.conflict) return {status:409,body:{ok:false,code:'CONFLICT',message:'修订冲突',details:{requestId:'fixture-conflict'}}};
          if(request.method==='scheduledTasks.local.update'||request.method==='scheduledTasks.local.setEnabled') {
            if(f.pending) await new Promise(resolve=>f.release=resolve);
            const updated={...task,...b,id:b.taskId,revision:5};
            f.items=f.items.map(item=>item.id===b.taskId?updated:item);
            return {status:200,body:{ok:true,task:updated}}; }
          if(request.method==='scheduledTasks.local.delete') {if(f.pending) await new Promise(resolve=>f.release=resolve);f.deleted=true;f.items=f.items.filter(item=>item.id!==b.taskId);f.total=f.items.length;return {status:200,body:{ok:true,deleted:true,task:{...task,id:b.taskId,revision:5,deletedAt:123}}};}
          return {status:200,body:{ok:true,valid:true,nextRunAts:[123]}};
        }};
      const app=createApp({render:()=>h(ConfigProvider,{theme:{token:{colorPrimary:'#c96442',borderRadius:12},algorithm:theme.defaultAlgorithm}},
        {default:()=>h(Panel,{source:window.fixture.source.value,active:window.fixture.active.value})})});
      const pinia=createPinia();app.use(pinia);app.use(Antd);
      useConfigStore(pinia).$patch({desktopRuntime:{status:'ready',requestId:'fixture',releaseId:null,errorCode:null},desktopClient:{clientId:'local',workspaceIds:['local:ws'],connectedAt:1,version:'test'},workspaceId:null,sessionToken:null});
      window.fixture.config=useConfigStore(pinia);
      app.mount('#fixture');
    </script></body></html>` }));
  await page.goto("/__local-task-fixture");
  await expect(page.locator(".scheduled-tasks")).toBeVisible();
}

/** 账号夹具仅含假数据，任务结构沿用 shared 契约。 */
function accountTask(account: "A" | "B"): ScheduledTask {
  return { id: `task-${account}`, ownerUserId: `user-${account}`, clientId: 'remote', deviceId: 'remote-device',
    clientNameSnapshot: '远端设备', deviceLabelSnapshot: null, name: `账号${account}任务`, description: null,
    taskType: 'script', cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true,
    payload: { shell: 'sh', command: `SCRIPT_${account}_PRIVATE`, contextWorkspaceId: null, cwdRelative: '.', envRefs: [] },
    concurrencyPolicy: 'skip_if_running', missedPolicy: 'skip_missed', timeoutMs: 60000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
}

/** 通过原配置动作建立会话，保留真实同步 watch 与身份清理行为。 */
async function selectTaskAccount(page: Page, account: "A" | "B"): Promise<void> {
  await page.evaluate(account => {
    const config = (window as any).fixture.config as ReturnType<typeof useConfigStore>;
    config.serverWsOrigin = window.location.origin.replace(/^http/u, 'ws');
    config.setAccountSession({ sessionToken: `fixture-session-${account}`, sessionExpiresAt: Date.now() + 3_600_000,
      authMode: 'account', serverNow: Date.now(), accountRole: 'enterprise_admin', homePath: '/chat',
      accessContext: { identityType: 'ENTERPRISE_ADMIN', editionType: 'ENTERPRISE', editionStatus: 'ACTIVE',
        effectiveAccessScope: 'ENTERPRISE_ACTIVE', enterpriseId: 'fixture-enterprise', enterpriseName: '测试企业' },
      userSummary: { userId: `user-${account}`, email: `${account}@fixture.invalid`, fullName: `账号${account}`, phone: '', avatarUrl: null,
        accountRole: 'enterprise_admin', status: 'active', enterpriseId: 'fixture-enterprise', enterpriseName: '测试企业' } });
  }, account);
}

/** 复用真实面板夹具；拦截器只控制 HTTP 完成顺序，不调用组件内部方法。 */
async function installAccountTaskFixture(page: Page, intercept?: (route: Route) => Promise<boolean>) {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    (window as any).taskResponsesFinished = [];
    /** 只观察被标记的真实响应；下一任务开始时原请求的同步解析与 await 续体已执行。 */
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const marker = response.headers.get('x-codeflow-fixture-response');
      if (marker) {
        const finished = () => setTimeout(() => { (window as any).taskResponsesFinished.push(marker); }, 0);
        // 迟到401在读取正文前校验owner；200必须等到真实正文返回。
        if (response.status === 401) finished();
        else {
          const text = response.text.bind(response);
          response.text = async () => { try { return await text(); } finally { finished(); } };
        }
      }
      return response;
    };
  });
  const requests: { method: string; path: string; authorization: string | undefined }[] = [];
  await page.route('**/api/account/scheduled-tasks**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    requests.push({ method, path, authorization: request.headers().authorization });
    if (!['Bearer fixture-session-A', 'Bearer fixture-session-B'].includes(request.headers().authorization)) {
      throw new Error('UNEXPECTED_ACCOUNT_TASK_FIXTURE_AUTHORIZATION');
    }
    if (intercept && await intercept(route)) return;
    const task = accountTask(request.headers().authorization === 'Bearer fixture-session-B' ? 'B' : 'A');
    const device = { clientId: 'remote', deviceId: 'remote-device', clientName: '远端设备', deviceLabel: null,
      platform: 'linux', arch: 'x64', version: 'fixture', connectedAt: 1, workspaceIds: [] };
    if (method === 'GET' && path.endsWith('/devices')) await route.fulfill({ json: { ok: true, devices: [device] } });
    else if (method === 'GET' && path.endsWith('/device-assets')) await route.fulfill({ json: { ok: true, device, workspaces: [], workflows: [] } });
    else if (method === 'GET' && path === '/api/account/scheduled-tasks') await route.fulfill({ json: { ok: true, items: [task], total: 1 } });
    else if (method === 'POST' && path === `/api/account/scheduled-tasks/${task.id}`) await route.fulfill({ json: { ok: true, task } });
    else if (method === 'DELETE' && path === `/api/account/scheduled-tasks/${task.id}`) await route.fulfill({ json: { ok: true, deleted: true } });
    else throw new Error(`UNEXPECTED_ACCOUNT_TASK_FIXTURE_REQUEST: ${method} ${path}`);
  });
  await installLocalTaskFixture(page);
  await selectTaskAccount(page, 'A');
  await page.evaluate(() => { (window as any).fixture.source.value = 'account'; });
  await expect(page.getByText('账号A任务', { exact: true })).toBeVisible();
  return requests;
}

/** 200等待正文、401等待前置owner校验，再跨任务边界检查真实UI续体。 */
async function finishTaskResponse(page: Page, response: Promise<Response>, release: () => void): Promise<void> {
  release();
  const completed = await response;
  expect(await completed.finished()).toBeNull();
  const marker = await completed.headerValue('x-codeflow-fixture-response');
  expect(marker).toBeTruthy();
  await expect.poll(() => page.evaluate(marker => (window as any).taskResponsesFinished.includes(marker), marker)).toBe(true);
}

test.describe('D08 账号任务面板浏览器隔离', () => {
  for (const status of [200, 401]) {
    test(`A 列表迟到 ${status} 不回灌 B 或清除 B 会话`, async ({ page }, testInfo) => {
      let pending = false, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const requests = await installAccountTaskFixture(page, async route => {
        if (!pending || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/account/scheduled-tasks'
          || route.request().headers().authorization !== 'Bearer fixture-session-A') return false;
        await gate;
        await route.fulfill({ status, headers: { 'x-codeflow-fixture-response': 'late-A-list' }, json: status === 200 ? { ok: true, items: [accountTask('A')], total: 1 }
          : { ok: false, code: 'UNAUTHORIZED', message: '账号A已过期', details: { requestId: 'late-A' } } });
        return true;
      });
      try {
        pending = true;
        await page.getByRole('button', { name: /刷\s*新/u }).click();
        await expect.poll(() => requests.filter(request => request.path === '/api/account/scheduled-tasks').length).toBe(2);
        await selectTaskAccount(page, 'B');
        await expect(page.getByText('账号B任务', { exact: true })).toBeVisible();
        const response = page.waitForResponse(response => response.request().headers().authorization === 'Bearer fixture-session-A'
          && new URL(response.url()).pathname === '/api/account/scheduled-tasks');
        await finishTaskResponse(page, response, release);
        await expect(page.getByText('账号B任务', { exact: true })).toBeVisible();
        await expect(page.getByText('账号A任务', { exact: true })).toHaveCount(0);
        await expect(page.locator('.scheduled-tasks > .ant-alert-error')).toHaveCount(0);
        expect(await page.evaluate(() => [(window as any).fixture.config.sessionToken, (window as any).fixture.config.userSummary.userId]))
          .toEqual(['fixture-session-B', 'user-B']);
        await page.screenshot({ path: testInfo.outputPath(`late-${status}-B.png`) });
      } finally { release(); }
    });
  }

  test('换账号销毁编辑草稿、运行抽屉与删除确认，零旧 DELETE 派发', async ({ page }) => {
    const requests = await installAccountTaskFixture(page, async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/runs')) return false;
      await route.fulfill({ json: { ok: true, items: [{ id: 'run-A', taskId: 'task-A', scheduledAt: 1, status: 'success', summary: '账号A历史' }], total: 1 } });
      return true;
    });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑定时任务' });
    await edit.locator('input[name="codeflow-scheduled-task-name"]').fill('账号A未保存草稿');
    await selectTaskAccount(page, 'B');
    await expect(edit).not.toBeVisible();
    await expect(page.getByText('账号B任务', { exact: true })).toBeVisible();
    await selectTaskAccount(page, 'A');
    await expect(page.getByText('账号A任务', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '运行记录', exact: true }).click();
    await expect(page.getByText('账号A历史', { exact: true })).toBeVisible();
    await selectTaskAccount(page, 'B');
    await expect(page.locator('.ant-drawer-content')).not.toBeVisible();
    await expect(page.getByText('账号B任务', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = page.getByRole('dialog').filter({ hasText: '删除定时任务' });
    await expect(confirmation).toContainText('账号B任务');
    await selectTaskAccount(page, 'A');
    await expect(confirmation).not.toBeVisible();
    await expect(page.getByText('账号A任务', { exact: true })).toBeVisible();
    expect(requests.filter(request => request.method === 'DELETE')).toEqual([]);
  });

  test('同账号资料与 hello 刷新保留账号草稿，本机草稿跨云端登录仍可保存', async ({ page }) => {
    const requests = await installAccountTaskFixture(page);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑定时任务' });
    const name = edit.locator('input[name="codeflow-scheduled-task-name"]');
    await name.fill('同账号草稿');
    const count = requests.length;
    await page.evaluate(() => {
      const config = (window as any).fixture.config as ReturnType<typeof useConfigStore>;
      config.applyAccountProfile({ fullName: '更新资料', email: 'new@fixture.invalid', phone: '', avatarUrl: null,
        accountRole: 'enterprise_admin', accessContext: config.accessContext!, enterpriseSummary: { enterpriseId: 'fixture-enterprise', name: '测试企业' } });
      config.applySessionFromHello({ authMode: 'account', userSummary: { ...config.userSummary!, fullName: 'hello资料' } });
    });
    await expect(name).toHaveValue('同账号草稿');
    expect(requests).toHaveLength(count);
    await edit.getByRole('button', { name: '取 消' }).click();
    await page.evaluate(() => { (window as any).fixture.source.value = 'local'; });
    await expect(page.getByText('本机流程', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await name.fill('跨账号本机草稿');
    const localCount = requests.length;
    await selectTaskAccount(page, 'B');
    await expect(name).toHaveValue('跨账号本机草稿');
    await edit.getByRole('button', { name: '保 存' }).click();
    await expect(edit).not.toBeVisible();
    await expect(page.getByText('跨账号本机草稿', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(localCount);
    const write = await page.evaluate(() => (window as any).fixture.requests.find((request: any) => request.method === 'scheduledTasks.local.update'));
    expect(write.body).toMatchObject({ taskId: 'local-task', expectedRevision: 4, name: '跨账号本机草稿' });
  });

  test('A 保存迟到不关闭 B 的在途弹框，不解锁或提示旧成功', async ({ page }) => {
    const releases: (() => void)[] = [];
    const gates = ['A', 'B'].map(() => new Promise<void>(resolve => { releases.push(resolve); }));
    let saves = 0;
    await installAccountTaskFixture(page, async route => {
      if (route.request().method() !== 'POST') return false;
      const account = route.request().headers().authorization === 'Bearer fixture-session-B' ? 'B' : 'A';
      saves++;
      await gates[account === 'A' ? 0 : 1];
      await route.fulfill({ headers: { 'x-codeflow-fixture-response': `save-${account}` }, json: { ok: true, task: accountTask(account) } });
      return true;
    });
    try {
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const edit = page.getByRole('dialog', { name: '编辑定时任务' });
      await edit.getByRole('button', { name: '保 存' }).click();
      await expect.poll(() => saves).toBe(1);
      await selectTaskAccount(page, 'B');
      await expect(edit).not.toBeVisible();
      await expect(page.getByText('账号B任务', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await edit.locator('input[name="codeflow-scheduled-task-name"]').fill('账号B保存中');
      await edit.getByRole('button', { name: '保 存' }).click();
      await expect.poll(() => saves).toBe(2);
      const response = page.waitForResponse(response => response.request().method() === 'POST'
        && response.request().headers().authorization === 'Bearer fixture-session-A');
      await finishTaskResponse(page, response, releases[0]);
      await expect(edit.locator('input[name="codeflow-scheduled-task-name"]')).toHaveValue('账号B保存中');
      await expect(edit.getByRole('button', { name: '取 消' })).toBeDisabled();
      await expect(page.getByText('定时任务已保存', { exact: true })).toHaveCount(0);
      releases[1]();
      await expect(edit).not.toBeVisible();
      await expect(page.getByText('定时任务已保存', { exact: true })).toHaveCount(1);
    } finally { releases.forEach(release => release()); }
  });

  test('本人运行 401 明确失败，真实 console 日志保关联且排除两份脚本及 token', async ({ page }, testInfo) => {
    const logs: unknown[][] = [], reads: Promise<void>[] = [];
    page.on('console', message => {
      if (message.type() === 'error' && message.text().startsWith('SCHEDULED_TASK_UI_FAILED')) {
        reads.push(Promise.all(message.args().map(arg => arg.jsonValue())).then(args => { logs.push(args); }));
      }
    });
    await installAccountTaskFixture(page, async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/run')) return false;
      await route.fulfill({ status: 401, json: { ok: false, code: 'UNAUTHORIZED', message: '运行授权已过期 SCRIPT_A_PRIVATE SCRIPT_DRAFT_PRIVATE fixture-session-A',
        details: { requestId: 'SCRIPT_DRAFT_PRIVATE' } } });
      return true;
    });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑定时任务' });
    await edit.locator('textarea[name="codeflow-scheduled-task-command"]').fill('  SCRIPT_DRAFT_PRIVATE  ');
    await edit.getByRole('button', { name: '取 消' }).click();
    await page.getByRole('button', { name: '立即运行', exact: true }).click();
    await expect(page.locator('.scheduled-tasks > .ant-alert-error')).toContainText('运行授权已过期');
    await expect.poll(() => logs.length).toBe(1);
    await Promise.all(reads);
    expect(logs[0]).toEqual(['SCHEDULED_TASK_UI_FAILED', { code: 'UNAUTHORIZED', requestId: 'fixture', userId: 'user-A',
      taskId: 'task-A', source: 'account', operation: 'runNow', cause: '任务接口返回失败' }]);
    const serialized = JSON.stringify(logs);
    for (const secret of ['SCRIPT_A_PRIVATE', 'SCRIPT_DRAFT_PRIVATE', 'fixture-session-A']) expect(serialized).not.toContain(secret);
    expect(await page.evaluate(() => [(window as any).fixture.config.sessionToken, (window as any).fixture.config.userSummary])).toEqual([null, null]);
    await testInfo.attach('safe-console', { body: serialized, contentType: 'application/json' });
  });
});

test.describe("D08a4 本机定时任务真实面板", () => {
  test("R2 启停等待期间换页最终收敛当前页且旧页响应不回灌",async({page})=>{
    await installLocalTaskFixture(page);
    await page.evaluate(()=>{const f=(window as any).fixture;const task=f.items[0];f.items=[task,...Array.from({length:20},(_,index)=>({...task,id:'next-'+index,name:'后页任务 '+(index+1)}))];f.total=21;});
    await page.getByRole('button',{name:/刷\s*新/u}).click();
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=true;f.deferList=true;});
    await page.getByRole('switch',{name:'启用 本机流程'}).click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.release))).toBe(true);
    await page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-2').click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.releaseList))).toBe(true);
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.deferList=false;f.release();});
    await page.evaluate(()=>{(window as any).fixture.releaseList();});
    await expect(page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-active')).toHaveText('2');
    await expect(page.getByText('后页任务 20',{exact:true})).toBeVisible();
    await expect(page.getByText('本机流程',{exact:true})).not.toBeVisible();
    await expect(page.locator('.scheduled-tasks__table .ant-spin-spinning')).toHaveCount(0);
    await page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-1').click();
    await expect(page.getByRole('switch',{name:'启用 本机流程'})).toHaveAttribute('aria-checked','false');
    await page.getByRole('switch',{name:'启用 本机流程'}).click();
    const body=await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.setEnabled').at(-1).body);
    expect(body).toEqual({taskId:'local-task',expectedRevision:5,enabled:true});
  });

  test("R1 启停成功不被并行旧列表覆盖，下一次写入使用新修订",async({page})=>{
    await installLocalTaskFixture(page);
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=true;f.deferList=true;});
    const toggle=page.getByRole('switch',{name:'启用 本机流程'});
    await toggle.click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.release))).toBe(true);
    await page.getByRole('button',{name:/刷\s*新/u}).click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.releaseList))).toBe(true);
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.deferList=false;f.release();});
    await expect(toggle).toHaveAttribute('aria-checked','false');
    await page.evaluate(()=>{const f=(window as any).fixture;f.deferList=false;f.releaseList();});
    await expect(page.locator('.scheduled-tasks__table .ant-spin-spinning')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-checked','false');
    await toggle.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.setEnabled').length)).toBe(2);
    const body=await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.setEnabled').at(-1).body);
    expect(body).toEqual({taskId:'local-task',expectedRevision:5,enabled:true});
  });

  test("R1 等待账号设备的新建在来源切换后不打开本机草稿",async({page})=>{
    let releaseDevices!:()=>void;
    const pendingDevices=new Promise<void>(resolve=>{releaseDevices=resolve;});
    let deviceRequests=0;
    await page.route('**/api/account/scheduled-tasks**',async route=>{
      if(new URL(route.request().url()).pathname.endsWith('/devices')) {
        deviceRequests++;
        await pendingDevices;
        await route.fulfill({json:{ok:true,devices:[]}});
      } else await route.fulfill({json:{ok:true,items:[],total:0}});
    });
    await installLocalTaskFixture(page);
    await page.evaluate(()=>{const f=(window as any).fixture;f.config.$patch({serverWsOrigin:'ws://127.0.0.1:39290',authMode:'account',accountRole:'enterprise_admin',userSummary:{userId:'fixture-user'},sessionToken:'fixture-session',sessionExpiresAt:Date.now()+3_600_000});f.source.value='account';});
    await expect.poll(()=>deviceRequests).toBe(1);
    await page.getByRole('button',{name:/新\s*建/u}).click();
    await expect.poll(()=>deviceRequests).toBe(2);
    await page.evaluate(()=>{(window as any).fixture.source.value='local';});
    await expect(page.getByText('本机流程',{exact:true})).toBeVisible();
    releaseDevices();
    await expect.poll(()=>page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/scheduled-tasks/devices')).length)).toBe(2);
    await expect(page.getByRole('dialog',{name:'新建定时任务'})).not.toBeVisible();
    expect(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='workspaces.list'))).toEqual([]);
  });

  test("R1 删除末页唯一任务按真实总数夹断页码并读取上一页",async({page})=>{
    await installLocalTaskFixture(page);
    await page.evaluate(()=>{const f=(window as any).fixture;const task=f.items[0];f.items=Array.from({length:21},(_,index)=>({...task,id:'task-'+index,name:'末页任务 '+index}));f.total=21;});
    await page.getByRole('button',{name:/刷\s*新/u}).click();
    await page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-2').click();
    await expect(page.getByText('末页任务 20',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('dialog').filter({hasText:'删除定时任务'}).getByRole('button',{name:/删\s*除/u}).click();
    await expect(page.getByRole('dialog').filter({hasText:'删除定时任务'})).not.toBeVisible();
    await expect(page.getByText('末页任务 0',{exact:true})).toBeVisible();
    await expect(page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-active')).toHaveText('1');
    const request=await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.list').at(-1));
    expect(request.body).toEqual({limit:20,offset:0});
    expect(await page.locator('.scheduled-tasks__table .ant-table-row').count()).toBe(20);
  });

  test("关闭时零读取，激活免账号且列表与历史按真实 total 分页", async ({ page }) => {
    const http: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) http.push(request.url()); });
    await installLocalTaskFixture(page, false);
    expect(await page.evaluate(() => (window as any).fixture.requests)).toEqual([]);
    await page.evaluate(() => { (window as any).fixture.active.value = true; });
    await expect(page.getByText("本机流程", { exact: true })).toBeVisible();
    await page.locator('.scheduled-tasks > .ant-pagination .ant-pagination-item-2').click();
    await expect.poll(() => page.evaluate(() => (window as any).fixture.requests.filter((r: any) => r.method === 'scheduledTasks.local.list').at(-1).body.offset)).toBe(20);
    await page.getByRole('button', { name: '全部运行记录' }).click();
    await expect(page.getByText('已删除名称快照')).toBeVisible();
    await expect(page.getByText('已触发', { exact: true })).toBeVisible();
    await page.locator('.ant-drawer .ant-pagination-item-2').click();
    const last = await page.evaluate(() => (window as any).fixture.requests.filter((r: any) => r.method === 'scheduledTasks.local.runs').at(-1).body);
    expect(last).toEqual({ limit: 20, offset: 20 });
    expect(http).toEqual([]);
  });

  test("编辑锁定归属并保留隐藏字段、毫秒与冲突草稿", async ({ page }) => {
    await installLocalTaskFixture(page);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑定时任务' });
    await expect(dialog.getByText('missing-flow', { exact: true })).toBeVisible();
    await expect(dialog.locator('.ant-select-disabled')).toHaveCount(1);
    await dialog.locator('input[name="codeflow-scheduled-task-name"]').fill('编辑草稿');
    await page.evaluate(() => { (window as any).fixture.conflict = true; });
    await dialog.getByRole('button', { name: '保 存' }).click();
    await expect(dialog).toContainText('刷新');
    await expect(dialog.locator('input[name="codeflow-scheduled-task-name"]')).toHaveValue('编辑草稿');
    await page.evaluate(() => { (window as any).fixture.conflict = false; });
    await dialog.getByRole('button', { name: '保 存' }).click();
    await expect(dialog).not.toBeVisible();
    const body = await page.evaluate(() => (window as any).fixture.requests.filter((r: any) => r.method === 'scheduledTasks.local.update').at(-1).body);
    expect(body).toMatchObject({ expectedRevision: 4, timeoutMs: 60001, concurrencyPolicy:'queue_one',missedPolicy:'run_once_on_reconnect',
      payload:{ workflowId:'missing-flow',contextWorkspaceId:'local:ws',intake:{goal:'原目标',acceptanceCriteria:['保留验收']},interactionMode:'autonomous',workflowVersionPolicy:null,runMode:null,approvalMode:null } });
    expect(body).not.toHaveProperty('deviceId');
  });

  test("关闭及来源切换使迟到读取失效", async ({ page }) => {
    await installLocalTaskFixture(page, false);
    await page.evaluate(() => { const f=(window as any).fixture;f.pending=true;f.active.value=true; });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).fixture.release))).toBe(true);
    await page.evaluate(() => { const f=(window as any).fixture;f.active.value=false;f.pending=false;f.release(); });
    await expect(page.getByText('本机流程', {exact:true})).not.toBeVisible();
    await page.evaluate(() => { const f=(window as any).fixture;f.pending=true;f.active.value=true;f.release=null; });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).fixture.release))).toBe(true);
    await page.route('**/api/account/scheduled-tasks*', route => route.fulfill({json:{ok:true,items:[],total:0}}));
    await page.evaluate(() => { const f=(window as any).fixture;f.source.value='account';f.pending=false;f.release(); });
    await expect(page.getByText('本机流程', {exact:true})).not.toBeVisible();
  });

  test("受控启停等待成功，删除失败保留确认框，删除后全部历史仍可读取", async ({ page }) => {
    await installLocalTaskFixture(page);
    await page.evaluate(() => { (window as any).fixture.pending=true; });
    const toggle=page.getByRole('switch', {name:'启用 本机流程'});
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked','true');
    await expect.poll(() => page.evaluate(() => Boolean((window as any).fixture.release))).toBe(true);
    await page.evaluate(() => {const f=(window as any).fixture;f.pending=false;f.release();});
    await expect(toggle).toHaveAttribute('aria-checked','false');
    await page.getByRole('button', {name:'删除',exact:true}).click();
    const confirmation=page.getByRole('dialog').filter({hasText:'删除定时任务'});
    await page.evaluate(() => {(window as any).fixture.conflict=true;});
    await confirmation.getByRole('button', {name:/删\s*除/u}).click();
    await expect(confirmation).toBeVisible();
    await expect(page.locator('.scheduled-tasks > .ant-alert-error')).toContainText('修订冲突');
    await page.evaluate(() => {(window as any).fixture.conflict=false;});
    await confirmation.getByRole('button', {name:/删\s*除/u}).click();
    await expect(confirmation).not.toBeVisible();
    await expect(page.getByText('本机流程', {exact:true})).not.toBeVisible();
    await page.getByRole('button', {name:'全部运行记录'}).click();
    await expect(page.getByText('已删除名称快照')).toBeVisible();
    const writes=await page.evaluate(() => (window as any).fixture.requests.filter((r:any)=>/setEnabled|delete/u.test(r.method)));
    expect(writes[0].body).toEqual({taskId:'local-task',expectedRevision:4,enabled:false});
    expect(writes[1].body).toEqual({taskId:'local-task',expectedRevision:5});
  });

  test("无工作区脚本编辑锁定空归属且不能切成工作流", async ({page}) => {
    await installLocalTaskFixture(page);
    await page.evaluate(()=>{const f=(window as any).fixture;f.items=[{...f.items[0],name:'无工作区脚本',taskType:'script',workspaceScope:null,
      payload:{shell:'sh',command:'pwd',contextWorkspaceId:null,cwdRelative:'.',envRefs:['PATH']}}];});
    await page.getByRole('button',{name:/刷\s*新/u}).click();
    await page.getByRole('button',{name:'编辑',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'编辑定时任务'});
    await expect(dialog.locator('.ant-segmented-item').filter({hasText:'工作流'})).toHaveClass(/disabled/u);
    await expect(dialog.locator('.ant-select-disabled')).toHaveCount(1);
    await dialog.locator('input[name="codeflow-scheduled-task-name"]').fill('仍无归属');
    await dialog.getByRole('button',{name:'保 存'}).click();
    await expect(dialog).not.toBeVisible();
    const body=await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.update').at(-1).body);
    expect(body).toMatchObject({taskType:'script',payload:{contextWorkspaceId:null,envRefs:['PATH']}});
  });

  test("取消预览后新表单不接收迟到结果，保存期间由Modal props阻止取消",async({page})=>{
    await installLocalTaskFixture(page);
    await page.getByRole('button',{name:'编辑',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'编辑定时任务'});
    await page.evaluate(()=>{(window as any).fixture.pending=true;});
    await dialog.getByRole('button',{name:'预览 Cron'}).click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.release))).toBe(true);
    await dialog.getByRole('button',{name:'取 消'}).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button',{name:'编辑',exact:true}).click();
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.release();f.release=null;});
    await expect(dialog.locator('.scheduled-tasks__preview')).toHaveCount(0);
    await page.evaluate(()=>{(window as any).fixture.pending=true;});
    await dialog.getByRole('button',{name:'保 存'}).click();
    await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.release))).toBe(true);
    await expect(dialog.getByRole('button',{name:'取 消'})).toBeDisabled();
    await expect(dialog.getByRole('button',{name:'Close'})).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.release();});
    await expect(dialog).not.toBeVisible();
  });

  test("本机新建只显示真实本机工作区，脚本可无工作区且缺桥不走HTTP",async({page})=>{
    const http:string[]=[];
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))http.push(request.url());});
    await installLocalTaskFixture(page);
    await page.getByRole('button',{name:/新\s*建/u}).click();
    const dialog=page.getByRole('dialog',{name:'新建定时任务'});
    await dialog.getByText('脚本',{exact:true}).click();
    await dialog.locator('input[name="codeflow-scheduled-task-name"]').fill('新本机脚本');
    await dialog.locator('textarea[name="codeflow-scheduled-task-command"]').fill('pwd');
    const select=dialog.locator('.ant-form-item').filter({has:page.locator('.ant-form-item-label label[title="工作区"]')}).locator('.ant-select');
    await select.click();
    await expect(page.locator('.ant-select-dropdown').getByText('本机工作区',{exact:true})).toBeVisible();
    await expect(page.locator('.ant-select-dropdown').getByText('异机',{exact:true})).toHaveCount(0);
    await dialog.locator('input[name="codeflow-scheduled-task-name"]').click();
    await dialog.getByRole('button',{name:'保 存'}).click();
    await expect(dialog).not.toBeVisible();
    const body=await page.evaluate(()=>(window as any).fixture.requests.find((r:any)=>r.method==='scheduledTasks.local.create').body);
    expect(body.payload.contextWorkspaceId).toBeNull();
    for(const key of ['id','ownerUserId','clientId','deviceId','source','workspaceScope'])expect(body).not.toHaveProperty(key);
    await page.evaluate(()=>{delete (window as any).codeflowDesktop;});
    await page.getByRole('button',{name:/刷\s*新/u}).click();
    await expect(page.locator('.scheduled-tasks > .ant-alert-error')).toContainText('DESKTOP_BRIDGE_REQUIRED');
    expect(http).toEqual([]);
  });

  test("来源切换销毁本组件删除确认且零错误来源派发", async ({page}) => {
    await installLocalTaskFixture(page);
    await page.getByRole('button',{name:'删除',exact:true}).click();
    const dialog=page.getByRole('dialog').filter({hasText:'删除定时任务'});
    await expect(dialog).toBeVisible();
    await page.route('**/api/account/scheduled-tasks**', route=>route.fulfill({json:{ok:true,items:[],total:0,devices:[]}}));
    await page.evaluate(()=>{(window as any).fixture.source.value='account';});
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.delete'))).toEqual([]);
  });

  for (const operation of ['update','setEnabled','delete']) {
    test(`${operation} 在途成功不写回切换后的来源`, async ({page}) => {
      await installLocalTaskFixture(page);
      await page.evaluate(()=>{(window as any).fixture.pending=true;});
      if(operation==='update') {
        await page.getByRole('button',{name:'编辑',exact:true}).click();
        await page.getByRole('dialog',{name:'编辑定时任务'}).getByRole('button',{name:'保 存'}).click();
      } else if(operation==='setEnabled') await page.getByRole('switch',{name:'启用 本机流程'}).click();
      else {
        await page.getByRole('button',{name:'删除',exact:true}).click();
        await page.getByRole('dialog').filter({hasText:'删除定时任务'}).getByRole('button',{name:/删\s*除/u}).click();
      }
      await expect.poll(()=>page.evaluate(()=>Boolean((window as any).fixture.release))).toBe(true);
      await page.route('**/api/account/scheduled-tasks**',route=>route.fulfill({json:{ok:true,items:[],total:0,devices:[]}}));
      await page.evaluate(()=>{const f=(window as any).fixture;f.source.value='account';});
      await expect(page.locator('.scheduled-tasks')).toContainText('暂无定时任务');
      await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.release();});
      await expect(page.getByText('本机流程',{exact:true})).not.toBeVisible();
      expect(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method==='scheduledTasks.local.list').length)).toBe(1);
    });
  }

  for (const viewport of [{width:1366,height:900},{width:390,height:844}]) {
    test(`${viewport.width} 加载、空、少、多保持同外高并在表格内滚动`, async ({page},testInfo) => {
      await page.setViewportSize(viewport);
      await installLocalTaskFixture(page);
      const panel=page.locator('.scheduled-tasks');
      const heights:number[]=[];
      for (const state of ['loading','empty','sparse','many']) {
        await page.evaluate((state) => {
          const f=(window as any).fixture;
          const task=f.items[0]||f.original;f.original=task;
          f.pending=state==='loading';
          f.items=state==='empty'?[]:state==='many'?Array.from({length:80},(_,index)=>({...task,id:'task-'+index,name:'本机任务 '+index})):[task];
          f.total=f.items.length;
        },state);
        await panel.getByRole('button',{name:/刷\s*新/u}).click();
        if(state==='loading') await expect(panel.locator('.ant-spin-spinning')).toBeVisible();
        else await expect(panel.locator('.ant-spin-spinning')).toHaveCount(0);
        heights.push(await panel.evaluate(element=>element.getBoundingClientRect().height));
        await expect(panel.locator(':scope > .ant-pagination')).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
        if(state==='many') {
          const body=panel.locator('.ant-table-body');
          expect(await body.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
        }
        await page.screenshot({path:testInfo.outputPath(`${viewport.width}-${state}.png`)});
        if(state==='loading') await page.evaluate(()=>{const f=(window as any).fixture;f.pending=false;f.release();});
      }
      expect(Math.max(...heights)-Math.min(...heights)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('D08a4 本机应用入口',()=>{
  for(const viewport of [{width:1366,height:900},{width:390,height:844}]) {
    test(`${viewport.width} 无账号、无工作区、Server离线仍能进入定时任务`,async({page},testInfo)=>{
      await page.setViewportSize(viewport);
      await page.addInitScript(()=>{
        localStorage.clear();sessionStorage.clear();
        (window as any).localTaskRequests=[];
        (window as any).codeflowDesktop={
          getState:async()=>({status:'ready',requestId:'shell-fixture',releaseId:null,errorCode:null}),onEvent:()=>()=>{},openWindow:async()=>{},exit:async()=>{},
          request:async(request:any)=>{
            (window as any).localTaskRequests.push(structuredClone(request));
            if(request.method==='runtime.info') return {status:200,body:{ok:true,client:{clientId:'local',workspaceIds:[],connectedAt:1,version:'test'}}};
            if(request.method==='runtime.cloudAccount.unlink') return {status:200,body:{ok:true,account:{status:'unlinked',generation:0,serverOrigin:null,userSummary:null,errorCode:null}}};
            if(request.method==='workspaces.list') return {status:200,body:{ok:true,workspaces:[],workspaceListAuthoritative:true}};
            if(request.method==='scheduledTasks.local.list') return {status:200,body:{ok:true,items:[],total:0}};
            throw new Error('UNEXPECTED_SHELL_FIXTURE_METHOD:'+request.method);
          }};
      });
      await page.goto('/chat');
      const settings=page.getByRole('dialog').filter({hasText:'工作区'});
      await expect(settings).toBeVisible();
      await settings.getByRole('button',{name:'Close',exact:true}).click();
      await expect(settings).not.toBeVisible();
      if(viewport.width>=768) {
        await page.locator('.app-topbar').getByRole('button',{name:/设置/u}).click();
        await page.locator('.admin-layout__nav-item').filter({hasText:'定时任务'}).click();
      } else {
        await page.getByRole('button',{name:'打开个人信息',exact:true}).click();
        await page.getByRole('button',{name:'定时任务',exact:true}).click();
      }
      await expect(page.locator('.scheduled-tasks')).toBeVisible();
      await expect(page.locator('.scheduled-tasks')).toContainText('暂无定时任务');
      expect(await page.evaluate(()=>(window as any).localTaskRequests.filter((r:any)=>r.method==='scheduledTasks.local.list').length)).toBeGreaterThan(0);
      await expect.poll(()=>page.locator('.scheduled-tasks').evaluate(element=>Math.round(element.getBoundingClientRect().x))).toBeLessThan(500);
      await expect(page.locator('.ant-drawer-mask:visible')).toHaveCount(0);
      await page.screenshot({path:testInfo.outputPath(`${viewport.width}-shell-entry.png`)});
      if(viewport.width<768) {
        await page.locator('.mobile-page__header').getByRole('button').first().click();
        await expect(page.locator('.h5-profile-drawer')).toBeVisible();
        await expect(page.getByRole('button',{name:'定时任务',exact:true})).toBeVisible();
      }
    });
  }
});

test.describe('D08a4 未登录桌面设置入口',()=>{
  /** 只替换可信 preload 边界；本机工作区已就绪且没有账号会话。 */
  async function installDesktopSettingsFixture(page: Page): Promise<void> {
    await page.addInitScript(()=>{
      localStorage.clear();sessionStorage.clear();
      (window as any).desktopRequests=[];
      (window as any).codeflowDesktop={
        getState:async()=>({status:'ready',requestId:'shell-fixture',releaseId:null,errorCode:null}),onEvent:()=>()=>{},openWindow:async()=>{},exit:async()=>{},
        request:async(request:any)=>{
          (window as any).desktopRequests.push(structuredClone(request));
          const body=request.body||{};
          if(request.method==='runtime.info') return {status:200,body:{ok:true,client:{clientId:'local',workspaceIds:['local:ws'],connectedAt:1,version:'test'}}};
          if(request.method==='runtime.cloudAccount.unlink'||request.method==='runtime.cloudAccount.status')
            return {status:200,body:{ok:true,account:{status:'unlinked',generation:0,serverOrigin:null,userSummary:null,errorCode:null}}};
          if(request.method==='workspaces.list')
            return {status:200,body:{ok:true,workspaces:[{id:'local:ws',title:'本机工作区',path:'/local',createdAt:1,updatedAt:1}],workspaceListAuthoritative:true,activeClientCount:1,workspaceListSuccessCount:1,workspaceListFailureCount:0}};
          if(request.method==='codeflowai.config.get')
            return {status:200,body:{ok:true,path:'/local/codeflowai/codeflowai.json',config:{paths:{workflowDocsRoot:'codeflow-docs'}}}};
          if(request.method==='codeflowai.config.set')
            return {status:200,body:{ok:true,path:'/local/codeflowai/codeflowai.json',config:body.config}};
          if(request.method==='scheduledTasks.local.list') return {status:200,body:{ok:true,items:[],total:0}};
          if(request.method==='threads.list'||request.method==='threads.events') return {status:200,body:{ok:true,items:[],total:0}};
          if(request.method==='threads.groups.list') return {status:200,body:{ok:true,groups:[]}};
          if(request.method==='engines.status') return {status:200,body:{ok:true,engines:[]}};
          if(request.method==='engineKeys.list') return {status:200,body:{ok:true,keys:[]}};
          return {status:200,body:{ok:true}};
        }};
    });
  }

  /** 断言桥接被真实消费，避免把异步面板初始化误判为未请求。 */
  async function requested(page: Page, method: string): Promise<boolean> {
    return page.evaluate(name=>(window as any).desktopRequests.some((request:any)=>request.method===name),method);
  }

  test('未登录桌面从顶栏进入设置，仅加载本机面板并给出登录提示',async({page})=>{
    const accountRequests:string[]=[];
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/account/'))accountRequests.push(request.url());});
    await installDesktopSettingsFixture(page);
    await page.goto('/chat');
    const topbar=page.locator('.app-topbar');
    const settings=topbar.getByRole('button',{name:/设置/u});
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page.locator('.admin-layout')).toBeVisible();
    await expect(page).toHaveURL(/\/admin/u);
    await expect(page.locator('.admin-layout__nav-item')).toHaveCount(9);
    await expect(page.locator('.codeflowai-cfg__path')).toContainText('保存路径');
    await expect.poll(()=>requested(page,'codeflowai.config.get')).toBe(true);

    await page.locator('.admin-layout__nav-item').filter({hasText:'流量统计'}).click();
    await expect(page.getByText('登录后可用',{exact:true})).toBeVisible();
    await expect(page.locator('.admin-layout__content').getByText('流量统计',{exact:true})).toHaveCount(0);

    await page.locator('.admin-layout__nav-item').filter({hasText:'定时任务'}).click();
    await expect(page.locator('.scheduled-tasks')).toBeVisible();
    await expect(page.locator('.scheduled-tasks h2')).toHaveText('定时任务');
    await expect.poll(()=>requested(page,'scheduledTasks.local.list')).toBe(true);

    await topbar.getByRole('button',{name:/度量/u}).click();
    // 未登录时度量入口改为展示本机编排度量，而不是旧的登录提示。
    await expect(page.getByRole('region',{name:'本机编排度量'})).toBeVisible();
    expect(accountRequests).toEqual([]);
  });

  test('浏览器未登录仍隐藏设置与度量入口',async({page})=>{
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/auth\/login/u);
    await expect(page.locator('.app-topbar').getByRole('button',{name:/设置/u})).toHaveCount(0);
    await expect(page.locator('.app-topbar').getByRole('button',{name:/度量/u})).toHaveCount(0);
  });
});

// 注入登录态；WS 握手与账号/中转端点由 mock-codeflow-server 提供。
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "set-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "set-e2e-user", email: "set-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

test.describe("设置", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("ST-01 顶部设置入口打开管理视图", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await expect(page.locator(".thread-list")).toBeVisible();
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.locator(".admin-layout")).toBeVisible({ timeout: 10_000 });
  });

  for (const selfUpgrade of [false, true]) {
    test(selfUpgrade ? "安装版 Client 版本落后时仍自动提醒升级" : "源码 Client 版本落后时不自动提醒且隐藏升级入口", async ({ page }) => {
      const client = {
        clientId: "mock-client", version: "2026.10.07.02", connectedAt: 1,
        workspaceIds: ["workspace_chat_core_e2e"], capabilities: { selfUpgrade },
      };
      const latestVersion = "2026.10.14.01";
      await page.route("**/api/status", (route) => route.fulfill({ json: {
        ok: true, clientConnected: true, clientVersion: client.version, latestClientVersion: latestVersion, clients: [client],
      } }));
      await page.route("**/api/client/latest*", (route) => route.fulfill({ json: {
        ok: true, version: latestVersion, url: "/downloads/client.tgz",
      } }));
      await page.route("**/api/software/update-status*", (route) => route.fulfill({ json: { ok: true, items: [] } }));
      await page.routeWebSocket(/\/ws\/web/u, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((data) => {
          const message = JSON.parse(String(data));
          if (message.t === "presence.event" && message.event.type === "presence.updated") {
            message.event.payload.onlineClients = [client];
          }
          socket.send(JSON.stringify(message));
        });
      });
      await installSession(page);
      await page.goto("/chat");
      await expect(page.locator(".thread-list")).toBeVisible();
      const dialog = page.getByRole("dialog", { name: "Client状态" });
      if (selfUpgrade) {
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText("建议升级", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "全部升级", exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: /^升\s*级$/u })).toBeVisible();
      } else {
        await page.waitForLoadState("networkidle");
        await expect(dialog).not.toBeVisible();
        await expect(page.locator(".app-topbar__client-btn--attention")).toHaveCount(0);
        await page.getByRole("button", { name: /Client 在线/u }).click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText("源码运行", { exact: true })).toHaveCount(2);
        await expect(dialog.getByText("建议升级", { exact: true })).toHaveCount(0);
        await expect(dialog.getByText("可升级", { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: /^(全部升级|升\s*级)$/u })).toHaveCount(0);
      }
    });
  }
});

test.describe("电脑端账号头像不依赖可用 Key", () => {
  const cases = [
    { name: "未分配 Key", keyStatus: null, avatar: true, disconnected: false },
    { name: "Key 已停用", keyStatus: "disabled", avatar: true, disconnected: false },
    { name: "Key 已撤销", keyStatus: "revoked", avatar: true, disconnected: false },
    { name: "未分配 Key 且未上传头像", keyStatus: null, avatar: false, disconnected: false },
    { name: "Key 不可用且 Server 连接被拒绝", keyStatus: "disabled", avatar: true, disconnected: true },
  ] as const;

  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  for (const scenario of cases) {
    test(`${scenario.name}时保留头像、个人信息和退出入口`, async ({ page }, testInfo) => {
      const avatarUrl = scenario.avatar
        ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#237a57"/><circle cx="20" cy="20" r="10" fill="white"/></svg>')}`
        : null;
      let summaryRequests = 0;
      let connectionDenials = 0;
      await page.route("**/api/account/me/summary", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        summaryRequests++;
        await route.fulfill({ response, json: {
          ...body,
          avatarUrl,
          keySummary: scenario.keyStatus === null ? null : {
            userKeyId: "avatar-test-user-key", apiKeyId: "avatar-test-api-key",
            keyHash: "avatar-test-key-hash", keyPrefix: "", rawKey: null,
            status: scenario.keyStatus, lastSentAt: 0,
          },
        } });
      });
      if (scenario.disconnected) {
        await page.route("**/api/account/me/ws-bridge", async (route) => {
          connectionDenials++;
          await route.fulfill({ status: 403, json: { ok: false, code: "FORBIDDEN", message: "apiKey not allowed" } });
        });
      }
      await page.route("**/api/account/me/logout", (route) => route.fulfill({ json: { ok: true } }));
      await installSession(page);
      await page.goto("/chat");
      await expect.poll(() => summaryRequests).toBeGreaterThan(0);
      if (scenario.disconnected) await expect.poll(() => connectionDenials).toBeGreaterThan(0);

      const trigger = page.locator(".app-topbar .user-menu-trigger");
      await expect(trigger).toBeVisible();
      if (avatarUrl) {
        const image = trigger.locator(".account-avatar__image");
        await expect(image).toHaveAttribute("src", avatarUrl);
        await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      } else {
        await expect(trigger.locator(".account-avatar__fallback")).toHaveText("E用");
      }
      // 刷新也必须从账号状态恢复头像，不依赖运行时 Key 或 WebSocket 成功。
      await page.reload();
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(page.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
      await page.getByRole("menuitem", { name: "个人信息" }).click();
      const drawer = page.locator(".ant-drawer-content").filter({ has: page.locator(".account-drawer") });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator(".account-drawer__hero-avatar")).toBeVisible();
      await expect(drawer).toContainText("E2E 用户");
      await page.screenshot({ path: testInfo.outputPath("desktop-avatar.png") });
      await drawer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(drawer).toBeHidden();
      await trigger.click();
      await page.getByRole("menuitem", { name: "退出登录" }).click();
      await expect(page).toHaveURL(/\/auth\/login/u);
      await expect(page.locator("#login-email")).toBeVisible();
    });
  }
});

test.describe("移动端账号头像不依赖可用 Key", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const cases = [
    { name: "未分配 Key", status: null, avatar: true },
    { name: "Key 已停用", status: "disabled", avatar: true },
    { name: "Key 已撤销", status: "revoked", avatar: true },
    { name: "未分配 Key 且未上传头像", status: null, avatar: false },
  ] as const;

  for (const path of ["/chat", "/h5", "/office-h5/wecom", "/office-h5/dingtalk"]) {
    for (const scenario of cases) {
      test(`${path} ${scenario.name}时仍能查看账号和退出`, async ({ page, request }, testInfo) => {
        await request.post("http://127.0.0.1:39290/api/test/reset");
        const retiredRequests: string[] = [];
        page.on("request", (request) => {
          if (/^\/api\/(?:office-h5|h5)\//u.test(new URL(request.url()).pathname)) retiredRequests.push(request.url());
        });
        const response = await request.get("http://127.0.0.1:39290/api/account/me/summary");
        expect(response.ok()).toBeTruthy();
        const summary = await response.json();
        const avatarUrl = scenario.avatar
          ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#237a57"/></svg>')}`
          : null;
        const userSummary = {
          userId: summary.userId, email: summary.email, fullName: summary.fullName,
          phone: summary.phone, status: "active", avatarUrl, accountRole: summary.accountRole,
          enterpriseId: summary.enterpriseSummary?.enterpriseId ?? null,
          enterpriseName: summary.enterpriseSummary?.name ?? null,
        };
        await page.route("**/api/account/me/summary", (route) => route.fulfill({ json: {
          ...summary, avatarUrl,
          securitySummary: { lastPasswordChangedAt: 0, failedAttempts: 0, lockedUntil: 0, forceReset: false },
          keySummary: scenario.status === null ? null : {
            userKeyId: "mobile-avatar-user-key", apiKeyId: "mobile-avatar-api-key",
            keyHash: "mobile-avatar-key-hash", keyPrefix: "", rawKey: null,
            status: scenario.status, lastSentAt: 0,
          },
        } }));
        // 运行时授权失败不能清除账号身份或隐藏账号操作。
        await page.route("**/api/account/me/ws-bridge", (route) => route.fulfill({
          status: 403, json: { ok: false, code: "FORBIDDEN", message: "apiKey not allowed" },
        }));
        await page.route("**/api/account/enterprise/relay/status", (route) => route.fulfill({
          json: { ok: true, state: "disabled" },
        }));
        await page.route("**/api/account/me/logout", (route) => route.fulfill({ json: { ok: true } }));
        await installSession(page);
        await page.evaluate((user) => {
          const config = JSON.parse(localStorage.getItem("config")!);
          localStorage.setItem("config", JSON.stringify({ ...config, userSummary: user }));
        }, userSummary);
        await page.goto(path);
        await expect(page).toHaveURL(/\/chat(?:\?|$)/u);
        const trigger = page.getByRole("button", { name: "打开个人信息", exact: true });
        await expect(trigger).toBeVisible();
        if (avatarUrl) {
          const avatar = trigger.locator("img");
          await expect(avatar).toHaveAttribute("src", avatarUrl);
          await expect.poll(() => avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        } else {
          await expect(trigger.locator("span")).toHaveText("E");
        }
        await page.reload();
        await expect(trigger).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("mobile-avatar.png"), animations: "disabled" });
        await trigger.click();
        const settings = page.locator(".h5-settings");
        await settings.getByRole("button", { name: /个人信息/u }).click();
        const drawer = page.locator(".ant-drawer-content").filter({ has: page.locator(".account-drawer") });
        await expect(drawer).toBeVisible();
        await expect(page.locator(".account-drawer__h5-title strong")).toHaveText("个人信息");
        await page.getByRole("button", { name: "返回个人中心", exact: true }).click();
        await expect(drawer).toBeHidden();
        await settings.getByRole("button", { name: "退出登录", exact: true }).click();
        await expect(page).toHaveURL(/\/auth\/login/u);
        await expect(page.locator("#login-email")).toBeVisible();
        expect(retiredRequests).toEqual([]);
      });
    }
  }
});
