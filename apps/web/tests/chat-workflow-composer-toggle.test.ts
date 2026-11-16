import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createApiResultError, isApiResultError } from "../src/api/request.ts";

const composerSource = fs.readFileSync("apps/web/src/features/composer/components/chat-composer.vue", "utf8");
const chatPanelSource = fs.readFileSync("apps/web/src/features/chat/components/chat-panel.vue", "utf8");
const workflowPanelSource = fs.readFileSync("apps/web/src/features/chat/components/chat-workflow-panel.vue", "utf8");

const DESKTOP_TOOLBAR_OPEN = `<template v-if="props.surface !== 'h5'">`;

/** 按标签配对截取桌面端工具栏模板块，内层 <template> 不截断外块。 */
function desktopToolbarSource(): string {
  const start = composerSource.indexOf(DESKTOP_TOOLBAR_OPEN);
  assert.ok(start >= 0, "composer 应保留桌面端工具栏模板块");
  const tags = /<template\b|<\/template>/gu;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(composerSource); match; match = tags.exec(composerSource)) {
    depth += match[0] === "</template>" ? -1 : 1;
    if (depth === 0) return composerSource.slice(start, match.index);
  }
  throw new Error("桌面端工具栏模板块未闭合");
}

test("桌面工具栏按 Fast、Spec、WorkFlow、Agent 排列，H5 不渲染", () => {
  const toolbar = desktopToolbarSource();
  const fastIndex = toolbar.indexOf("Fast");
  const specIndex = toolbar.indexOf("Spec");
  const recommendIndex = toolbar.indexOf("WorkFlow");
  const agentIndex = toolbar.indexOf(`placeholder="Agent"`);
  assert.ok(fastIndex >= 0 && specIndex > fastIndex, "Spec 应排在 Fast 之后");
  assert.ok(recommendIndex > specIndex, "主动推荐按钮应排在 Spec 之后");
  assert.ok(agentIndex > recommendIndex, "主动推荐按钮应排在 Agent 之前");

  const separators = (start: number, end: number) => toolbar.slice(start, end).split("composer__toolbar-sep").length - 1;
  assert.equal(separators(fastIndex, specIndex), 1, "Fast 与 Spec 之间应恰好一个分隔符");
  assert.equal(separators(specIndex, recommendIndex), 1, "Spec 与主动推荐之间应恰好一个分隔符");
  assert.equal(separators(recommendIndex, agentIndex), 1, "主动推荐与 Agent 之间应恰好一个分隔符");

  assert.match(composerSource, /workflowToggleVisible\?: boolean;/u);
  assert.match(composerSource, /knowledgeToggleVisible\?: boolean;/u);
  assert.match(composerSource, /:aria-pressed="knowledgeEnabled"/u);
  assert.match(composerSource, /@click="toggleKnowledgeEnabled"/u);
  assert.match(chatPanelSource, /:knowledge-toggle-visible="chatKnowledgeToggleVisible"/u);
  assert.match(composerSource, /workflowToggleVisible: false,/u);
  assert.match(composerSource, /<span v-if="workflowToggleVisible" class="composer__toolbar-sep" \/>/u);
});

test("主动推荐开关复用现有激活态样式与可访问属性", () => {
  assert.match(composerSource, /:class="recommendationEnabled \? 'composer__toggle--on' : ''"/u);
  assert.match(composerSource, /:aria-pressed="recommendationEnabled"/u);
  assert.match(composerSource, /:disabled="composerWriteBlocked \|\| workflowToggleBusy"/u);
  assert.match(composerSource, /recommendation: '工作流模式/u);
});

test("主动推荐开关读走 getChatWorkflow、写走 setChatWorkflowEnabled，并丢弃迟到结果", () => {
  assert.match(composerSource, /import \{ getChatWorkflow, setChatWorkflowEnabled \} from "\.\.\/\.\.\/\.\.\/api\/chatWorkflow";/u);
  assert.match(composerSource, /getChatWorkflow\(ctx\.value, workspaceId, threadId\)/u);
  assert.match(composerSource, /setChatWorkflowEnabled\(ctx\.value, workspaceId, threadId, !recommendationEnabled\.value\)/u);
  assert.match(composerSource, /let workflowPrefVersion = 0;/u);
  const lateGuards = composerSource.match(/if \(version !== workflowPrefVersion \|\| workspaceId !== props\.workspaceId \|\| threadId !== props\.threadId\) return;/gu) ?? [];
  assert.ok(lateGuards.length >= 2, "读取与切换路径都要丢弃迟到结果");
});

test("会话面板按工作流面板同源条件下发开关可见性，H5 不下发", () => {
  assert.match(chatPanelSource, /const chatWorkflowVisible = computed\(\(\) => \{[\s\S]*?threadType === "chat" && !current\.threadSubtype && !props\.assistantMode[\s\S]*?\}\);/u);
  assert.match(chatPanelSource, /const chatWorkflowToggleVisible = computed\(\(\) => chatWorkflowVisible\.value && props\.surface !== "h5"\);/u);
  assert.match(chatPanelSource, /<ChatWorkflowPanel v-if="chatWorkflowVisible"[^>]*:reply-running="isConversationRunning\(displayConversation\)"/u);
  assert.match(workflowPanelSource, /const visibleTasks = computed\(\(\) => props\.replyRunning\s*\? \[\]\s*:\s*visibleChatWorkflowCards\(tasks\.value, hiddenTaskIds\.value\)\);/u);
  assert.match(workflowPanelSource, /if \(busy\.value \|\| props\.readOnly \|\| props\.replyRunning\) return;/u);
  assert.match(chatPanelSource, /:workflow-toggle-visible="chatWorkflowToggleVisible"/u);
});

test("工作流面板不再持有主动推荐开关与手动刷新入口", () => {
  assert.doesNotMatch(workflowPanelSource, /chat-workflow__toggle/u);
  assert.doesNotMatch(workflowPanelSource, /setChatWorkflowEnabled/u);
  assert.doesNotMatch(workflowPanelSource, /chat-workflow__toolbar|chat-workflow__icon|刷新工作流状态/u);
});

test("主动推荐开关失败路径保留 code 与 requestId 供排障", async () => {
  assert.match(composerSource, /import \{ createApiResultError, isApiResultError, isCancelledRequestError, type ApiRequestContext \} from "\.\.\/\.\.\/\.\.\/api\/request";/u);
  const script = composerSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/u)![1]!;
  const ast = ts.createSourceFile("composer.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["describeWorkflowFailure", "refreshWorkflowPreference", "toggleWorkflowRecommendation"]);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  assert.equal(functions.length, names.size, "执行真实工作流读写函数与错误描述函数");
  const code = ts.transpileModule(functions.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const action of ["read", "toggle"] as const) {
    const result = { ok: false as const, code: "INTERNAL_ERROR" as const, message: "工作流请求失败", details: { requestId: "request-workflow" } };
    const logs: Array<{ marker: string; details: Record<string, unknown> }> = [];
    const notices: string[] = [];
    const recommendationEnabled = { value: true };
    const workflowToggleBusy = { value: false };
    const context = vm.createContext({
      createApiResultError, isApiResultError, workflowPrefVersion: 0, recommendationEnabled, workflowToggleBusy,
      props: { workspaceId: "workspace", threadId: "thread", workflowToggleVisible: true },
      composerConnected: { value: true }, composerWriteBlocked: { value: false }, ctx: { value: {} },
      getChatWorkflow: async () => result, setChatWorkflowEnabled: async () => result,
      console: {
        /** 捕获业务边界日志，核对 API 错误上下文。 */
        warn(marker: string, details: Record<string, unknown>) { logs.push({ marker, details }); },
        /** 捕获切换失败日志，不影响真实异常转换逻辑。 */
        error(marker: string, details: Record<string, unknown>) { logs.push({ marker, details }); },
      },
      message: { error: (notice: string) => { notices.push(notice); } },
    });
    vm.runInContext(code, context);
    if (action === "read") await assert.rejects(context.refreshWorkflowPreference(), isApiResultError);
    else await context.toggleWorkflowRecommendation();
    assert.equal(recommendationEnabled.value, true, "失败不改动原开关状态");
    assert.equal(workflowToggleBusy.value, false, "失败后释放忙碌状态");
    assert.equal(notices.length, 1, "失败必须向用户显式提示");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.marker, `[chat-recommendation.${action}.failed]`);
    assert.equal(logs[0]!.details.code, result.code);
    assert.equal(logs[0]!.details.requestId, result.details.requestId);
    assert.equal(logs[0]!.details.workspaceId, "workspace");
    assert.equal(logs[0]!.details.threadId, "thread");
    assert.ok(isApiResultError(logs[0]!.details.error));
  }
});
