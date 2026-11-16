import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type KnowledgeBundleDefinition,
  type RoleDefinition,
  type RoleId,
  type ToolsetDefinition,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { prepareChatRoleSkills, resolveChatRoleRuntime } from "../../apps/desktop/client/src/app/chatRoleRuntime.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { OrchAssetAuthorityRuntimeReadService, createClientDbOrchAssetLegacyRuntimeReader } from "../../apps/desktop/client/src/orchestration/orchAssetAuthorityRuntimeReadService.ts";

/** 旧注入用例提供同一权威会话，保留跨工作区失败断言。 */
function fixtureReader(repos: any): any {
  return { withWorkspace: (_workspaceId: WorkspaceId, read: any) => read({ getAsset: (kind: string, id: string) => {
    const repo = kind === "role" ? repos.orchRoles : kind === "knowledge_bundle" ? repos.orchKnowledgeBundles : repos.orchToolsets;
    const definition = repo.get(id);
    return definition ? { assetType: kind, assetId: id, definition, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 2 } } : null;
  } }) };
}

/** 构造最小角色资产，覆盖普通聊天注入使用的字段。 */
function createRole(workspaceId: WorkspaceId): RoleDefinition {
  const executionConfig = createDefaultRoleExecutionConfig("codex");
  executionConfig.engineProfiles.codex = {
    enabled: true,
    mode: "custom",
    customConfig: {
      model: "gpt-should-not-leak",
      effort: "high",
      accessMode: "full-access",
    },
  };
  return {
    id: "role.analysis" as RoleId,
    workspaceId,
    name: "需求分析",
    description: "分析用户需求",
    responsibility: "负责澄清需求边界",
    systemPrompt: "只输出可验证结论",
    inputDefinition: {
      ...createDefaultRoleInputDefinition(),
      instructions: "读取用户问题和约束",
    },
    outputDefinition: {
      ...createDefaultRoleOutputDefinition(),
      instructions: "输出需求分析结论",
      resultKey: "analysis-report",
    },
    gateCriteria: [{ id: "gate.scope", label: "范围明确", type: "ai", config: "必须说明边界", blocking: true }],
    executionConfig,
    defaultKnowledgeBundleIds: ["kb.analysis" as any],
    toolRefs: [{ toolsetId: "toolset.analysis" as any, toolId: "tool.lookup" as any, required: true, usageGuidance: "仅在需要查证时调用" }],
    kind: "custom",
    createdAt: 1,
    updatedAt: 2,
  };
}

/** 构造含正文和文件引用的角色默认知识库。 */
function createKnowledgeBundle(workspaceId: WorkspaceId): KnowledgeBundleDefinition {
  return {
    id: "kb.analysis" as any,
    workspaceId,
    name: "分析知识",
    scope: "role",
    description: "角色默认知识",
    sourceRefs: [
      { id: "manual", kind: "manual-text", title: "团队约束", inlineBody: "团队约束正文", enabled: true },
      { id: "file", kind: "workspace-file", title: "规格文档", ref: "docs/spec.md", enabled: true },
    ],
    kind: "custom",
    createdAt: 1,
    updatedAt: 2,
  };
}

/** 构造角色绑定工具集，验证 toolRefs 会变成真实工具注册。 */
function createToolset(workspaceId: WorkspaceId): ToolsetDefinition {
  return {
    id: "toolset.analysis" as any,
    workspaceId,
    name: "分析工具集",
    description: "用于查证",
    tools: [{
      id: "tool.lookup" as any,
      name: "查证",
      description: "查证项目事实",
      runtime: "node",
      invocationHint: "输入 JSON",
      code: "console.log(JSON.stringify({ ok: true }))",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      requiresWrite: false,
    }],
    kind: "custom",
    createdAt: 1,
    updatedAt: 2,
  };
}

test("resolveChatRoleRuntime injects role prompt, knowledge and real tool registry for ordinary chat", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-chat-role-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "application.db") });
  try {
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "docs", "spec.md"), "spec", "utf8");
    const workspaceId = "ws-chat-role" as WorkspaceId;
    const role = createRole(workspaceId);
    const knowledgeBundle = createKnowledgeBundle(workspaceId);
    const toolset = createToolset(workspaceId);
    const runtime = resolveChatRoleRuntime({
      db, requestId: "chat-role-test",
      assetRuntimeRead: fixtureReader({
        orchRoles: { get: (id: RoleId) => id === role.id ? role : null },
        orchKnowledgeBundles: { get: (id: string) => id === knowledgeBundle.id ? knowledgeBundle : null },
        orchToolsets: { get: (id: string) => id === toolset.id ? toolset : null },
      }),
      workspaceId,
      workspacePath: tempDir,
      roleId: role.id,
      userMessage: "请分析这个需求",
    });

    assert.ok(runtime);
    assert.equal(runtime.requiresRoleToolTransport, true);
    assert.equal(runtime.toolRegistry?.tools[0]?.toolId, "tool.lookup");
    assert.equal(runtime.toolRegistry?.tools[0]?.runtime, "node");
    assert.match(runtime.systemRule, /负责澄清需求边界/);
    assert.match(runtime.systemRule, /普通聊天/);
    assert.match(runtime.developerMessage ?? "", /input_definition/);
    assert.match(runtime.developerMessage ?? "", /output_definition/);
    assert.match(runtime.developerMessage ?? "", /gate_criteria/);
    assert.match(runtime.developerMessage ?? "", /tool.lookup/);
    assert.doesNotMatch(runtime.developerMessage ?? "", /gpt-should-not-leak/);
    assert.match(runtime.userMessage, /请分析这个需求/);
    assert.match(runtime.userMessage, /团队约束正文/);
    assert.match(runtime.userMessage, /docs\/spec\.md/);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveChatRoleRuntime rejects role dependencies outside current workspace", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-role-mismatch-")), db = openClientDb({ dbPath: path.join(directory, "application.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "ws-chat-role" as WorkspaceId;
  const role = createRole(workspaceId);
  const knowledgeBundle = createKnowledgeBundle("ws-other" as WorkspaceId);
  assert.throws(
    () => resolveChatRoleRuntime({
      db, requestId: "chat-role-mismatch",
      assetRuntimeRead: fixtureReader({
        orchRoles: { get: (id: RoleId) => id === role.id ? role : null },
        orchKnowledgeBundles: { get: (id: string) => id === knowledgeBundle.id ? knowledgeBundle : null },
        orchToolsets: { get: () => null },
      }),
      workspaceId,
      workspacePath: process.cwd(),
      roleId: role.id,
      userMessage: "hello",
    }),
    /知识库不属于当前工作区/,
  );
});

test("ordinary chat uses one authority session including bound Skills and rejects missing dependencies", async (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-chat-role-authority-")));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "local:chat" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Role", path: directory });
  const workspaceDb = db.forWorkspace(workspaceId);
  const skill = workspaceDb.orchSkills.upsert({ id: "bound-skill" as any, workspaceId, name: "Bound Skill", slug: "bound-skill", description: "Bound skill",
    trigger: "analyze", instructions: "Use evidence", targetEngines: ["codex"], skillMd: "# Bound Skill\nUse evidence",
    scripts: [{ id: "run", name: "Evidence", description: "Evidence", scriptPath: "scripts/run.mjs", runtime: "node", exposeAsTool: true }],
    files: [{ relPath: "scripts/run.mjs", kind: "script", contentText: "console.log('evidence')", sizeBytes: 0, sha256: "" }] });
  const knowledge = workspaceDb.orchKnowledgeBundles.upsert({ ...createKnowledgeBundle(workspaceId), sourceRefs: [{ id: "manual", kind: "manual-text", title: "Evidence", inlineBody: "Authoritative knowledge", enabled: true }] });
  const toolset = workspaceDb.orchToolsets.upsert(createToolset(workspaceId));
  const role = workspaceDb.orchRoles.upsert({ ...createRole(workspaceId), defaultKnowledgeBundleIds: [knowledge.id],
    toolRefs: [{ toolsetId: toolset.id, toolId: toolset.tools[0]!.id }], defaultSkillIds: [skill.id] });
  const legacy = createClientDbOrchAssetLegacyRuntimeReader(workspaceDb, { requireCompleteDefinitions: true });
  let snapshots = 0;
  const reader = new OrchAssetAuthorityRuntimeReadService({ ...legacy,
    withReadSnapshot: (read: () => unknown) => { snapshots++; return workspaceDb.db.transaction(read)(); },
  } as any, { getAsset: () => { throw new Error("unexpected Server read"); }, listAssets: () => [] }, { getRuntimeReadinessRequirement: () => null });
  const input = { db: workspaceDb, requestId: "chat-role-authority",
    assetRuntimeRead: reader, workspaceId, workspacePath: directory, roleId: role.id, userMessage: "Analyze", engine: "codex" as const };
  const result = resolveChatRoleRuntime(input);
  assert.ok(result);
  assert.deepEqual(result.skills.map(item => item.id), [skill.id]);
  assert.match(result.developerMessage ?? "", /bound-skill/);
  assert.match(result.userMessage, /Authoritative knowledge/);
  assert.equal(result.toolRegistry?.tools.length, 2);
  assert.doesNotMatch(result.developerMessage ?? "", /gpt-should-not-leak/);
  assert.equal(snapshots, 1);
  const installed = await prepareChatRoleSkills(directory, result, "codex");
  assert.equal(installed[0]?.name, "bound-skill");
  assert.equal(fs.readFileSync(installed[0]!.expectedPath, "utf8"), skill.skillMd);
  const skillsRoot = path.dirname(path.dirname(installed[0]!.expectedPath));
  fs.rmSync(skillsRoot, { recursive: true });
  fs.writeFileSync(skillsRoot, "blocked", "utf8");
  await assert.rejects(prepareChatRoleSkills(directory, result, "codex"), /Skill.*安装失败/);
  assert.throws(() => resolveChatRoleRuntime({ ...input, engine: "claude" }), /不支持/);
  workspaceDb.orchSkills.delete(skill.id);
  assert.throws(() => resolveChatRoleRuntime(input), /Skill.*不存在/);
});
