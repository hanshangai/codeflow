import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkspaceKnowledgeChatContext } from "../src/app/workspaceKnowledgeChatContext.ts";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.ts";
import { defaultCodeflowaiConfig, writeCodeflowaiConfig } from "../src/codeflowai/codeflowaiConfig.js";
import { logger } from "../src/logger.ts";

test("普通会话知识入口和提示词随文档根配置变化", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-context-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeCodeflowaiConfig(root, { ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "项目资料" } });
  adoptSpecification(new KnowledgeAssetStore(root));
  const context = createContext(root);
  assert.equal(context.status, "ready");
  assert.equal(context.knowledgeRoot, "项目资料");
  assert.equal(context.knowledgeEntryPath, "项目资料/规格知识库");
  assert.match(context.systemRule!, /项目资料\/规格知识库/);
  assert.doesNotMatch(context.systemRule!, /codeflow-docs/);
});

function createContext(workspacePath: string) {
  return resolveWorkspaceKnowledgeChatContext({ workspacePath, engine: "codex" });
}

/** 写入一份已采用的正式规格，作为普通会话自动启用的最小夹具。 */
function adoptSpecification(store: KnowledgeAssetStore, content = "已采用规格：按项目约束实现与验证。") {
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), {
    id: "spec-global", parentId: "knowledge-specifications", title: "全局规格", orderKey: "0", summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "generated",
  }] }, null);
  store.saveDocument({ nodeId: "spec-global", content, sources: [], origin: "manual", expectedHash: null, adopt: true });
}

test("未初始化项目不注入知识工具", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-context-empty-"));
  try {
    const context = createContext(workspacePath);
    assert.equal(context.status, "not_initialized");
    assert.equal(context.reasonCode, "KNOWLEDGE_NOT_INITIALIZED");
    assert.deepEqual(context.requiredWorkspaceSkills, []);
    assert.equal(context.knowledgeAssetTools, undefined);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("存在已采用规格时，普通会话自动注册资产读取和修改提案工具", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-context-ready-"));
  try {
    const store = new KnowledgeAssetStore(workspacePath);
    adoptSpecification(store);
    const context = createContext(workspacePath);
    assert.equal(context.status, "ready");
    assert.equal(context.runtimeMode, "project_assets_v1");
    assert.deepEqual(context.requiredWorkspaceSkills, []);
    assert.equal(context.specifications?.rules[0]?.nodeId, "spec-global");
    const toolIds = context.knowledgeAssetTools?.tools.map(tool => tool.toolId) ?? [];
    assert.ok(toolIds.includes("knowledge.search"));
    assert.ok(toolIds.includes("knowledge.change.propose"));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("资产树就绪但没有已采用知识文档时不自动注入知识工具", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-context-disabled-"));
  try {
    const store = new KnowledgeAssetStore(workspacePath);
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), {
      id: "spec-draft", parentId: "knowledge-specifications", title: "未采用规格", orderKey: "0", summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "generated",
    }] }, null);
    const context = createContext(workspacePath);
    assert.equal(context.status, "ready");
    assert.equal(context.systemRule, null);
    assert.equal(context.knowledgeAssetTools, undefined);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("项目资产文件损坏时返回不可用状态并降级记录日志", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-context-broken-"));
  const warnings: Array<{ tag: string; message: string; data?: unknown }> = [];
  const originalWarn = logger.warn;
  try {
    const knowledgeRoot = path.join(workspacePath, "codeflow-docs", "规格知识库");
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.writeFileSync(path.join(knowledgeRoot, "knowledge.json"), "{\"schemaVersion\":1,\"id\":\"kb_test\"}", "utf8");
    fs.writeFileSync(path.join(knowledgeRoot, "tree.json"), "不是有效 JSON", "utf8");
    logger.warn = (tag: string, message: string, data?: unknown) => { warnings.push({ tag, message, data }); };
    const context = createContext(workspacePath);
    assert.equal(context.status, "unavailable");
    assert.equal(context.reasonCode, "KNOWLEDGE_READINESS_UNAVAILABLE");
    assert.deepEqual(context.requiredWorkspaceSkills, []);
    assert.equal(context.systemRule, null);
    assert.equal(context.knowledgeAssetTools, undefined);
    assert.ok(warnings.some(entry => entry.message === "[workspace-knowledge.auto-inject.skipped]"), "必须记录可检索的降级日志");
    const skipped = warnings.find(entry => entry.message === "[workspace-knowledge.auto-inject.skipped]")!;
    const payload = skipped.data as Record<string, unknown>;
    assert.equal(payload.code, "KNOWLEDGE_READINESS_UNAVAILABLE");
    assert.equal(Object.values(payload).some(value => typeof value === "string" && value.includes(workspacePath)), false, "日志不能包含工作区绝对路径");
  } finally {
    logger.warn = originalWarn;
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("设计阶段自动提供已采用的局部规格，快照绑定实际正文而不是只提供目录", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-design-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), {
    id: "backend-rules", parentId: "knowledge-specifications", title: "后端边界", orderKey: "0", summary: "", tags: [], instructions: "", sourceScope: [], appliesTo: ["src/server"], contentMode: "generated",
  }] }, null);
  const revision = store.saveDocument({ nodeId: "backend-rules", content: "前置失败时不得继续入账。", sources: [], origin: "manual", expectedHash: null, adopt: true });
  const context = resolveWorkspaceKnowledgeChatContext({ workspacePath: root, engine: "codex", paths: ["src/server"] });
  assert.match(context.systemRule!, /前置失败时不得继续入账/);
  assert.match(context.systemRule!, /src\/server/);
  assert.equal(context.specifications?.rules[0]?.revisionId, revision.id);
  assert.equal(context.specifications?.rules[0]?.contentHash, revision.contentHash);
  assert.ok(context.knowledgeAssetTools?.tools.some(tool => tool.toolId === "knowledge.acceptance.record"));
});

test("未知任务范围只提供局部索引，多个大型模块规则不阻断无关会话", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-many-scopes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), ...[0, 1, 2].map(index => ({
    id: `scope-${index}`, parentId: "knowledge-specifications", title: `模块 ${index}`, orderKey: String(index), summary: "", tags: [], instructions: "", sourceScope: [], appliesTo: [`module-${index}`], contentMode: "generated" as const,
  }))] }, null);
  for (const index of [0, 1, 2]) store.saveDocument({ nodeId: `scope-${index}`, content: "局部要求。".repeat(1920), sources: [], origin: "manual", expectedHash: null, adopt: true });
  const unknown = createContext(root);
  assert.equal(unknown.specifications?.rules.length, 0);
  assert.equal(unknown.specifications?.scoped.length, 3);
  const matched = resolveWorkspaceKnowledgeChatContext({ workspacePath: root, engine: "codex", paths: ["module-0/file.ts"] });
  assert.deepEqual(matched.specifications?.rules.map(rule => rule.nodeId), ["scope-0"]);
});
