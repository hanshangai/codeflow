import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MCP_SERVERS_REGISTRY, SKILL_SUITES_REGISTRY, type DesktopApiRequest, type WorkspaceId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";

/** 独立工作区使用真实 Client 入口与本地目录，无账号和 Server 上下文。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-skills-mcp-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "local:workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Local", path: directory });
  const ctx = { db, clientId: "local", workspaces: new Map([[workspaceId, directory]]), send() { assert.fail("request must stay local"); } } as unknown as ApiHandlerContext;
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspaceId,
    /** 方法名仍由生产白名单校验；测试可覆盖未接入时的明确失败。 */
    call(method: string, body: Record<string, unknown> = {}) {
      return executeDesktopApiRequest(ctx, { method, body: { workspaceId, ...body } } as DesktopApiRequest, { requestId: `skills-${method}`, startedAt: 1, clientVersion: "1" });
    },
  };
}

test("desktop lists the real Skill and MCP catalogs independently from platform assets", async t => {
  const f = fixture(t);
  const response = await f.call("skills.suites");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as any;
  assert.ok(SKILL_SUITES_REGISTRY.length > 0); assert.ok(MCP_SERVERS_REGISTRY.length > 0);
  assert.ok(SKILL_SUITES_REGISTRY.every(suite => body.suites.some((item: any) => item.suiteId === suite.suiteId)));
  assert.ok(MCP_SERVERS_REGISTRY.every(server => body.mcpServers.some((item: any) => item.mcpId === server.mcpId)));
  assert.equal(body.catalogOnly, undefined); assert.ok(Object.keys(body.targetStatus).length > 0);
});

test("desktop Skill and MCP requests reject forged authority and foreign workspaces", async t => {
  const f = fixture(t);
  for (const method of ["skills.suites", "skills.install", "skills.uninstall", "mcp.install", "mcp.enable", "mcp.update", "mcp.test", "mcp.import", "mcp.uninstall", "mcp.configure", "mcp.unconfigure"]) {
    for (const workspaceId of ["shared:team", "other:workspace", "local:missing"]) assert.ok((await f.call(method, { workspaceId })).status >= 400);
    assert.equal((await f.call(method, { actorUserId: "forged" })).status, 400);
  }
});

test("desktop Skill install and MCP import use existing handlers and fail invalid input", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.directory, ".vscode"));
  fs.writeFileSync(path.join(f.directory, ".vscode", "mcp.json"), "{invalid", "utf8");
  const imported = await f.call("mcp.import", { sources: ["vscode"] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.ok((imported.body as any).errors.length > 0);
  assert.deepEqual((imported.body as any).items, []);
  assert.equal((await f.call("skills.install", { targets: [], suiteId: "missing" })).status, 400);
});

test("desktop installs and removes local Skill suites through the original installer", async t => {
  const f = fixture(t), source = path.join(f.directory, "source", "local-check");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: local-check\ndescription: 本机检查\n---\n执行本机检查。", "utf8");
  const suite = { suiteId: "local-check-suite", name: "本机技能套件", installType: "local", localPath: path.dirname(source), source: "custom" };
  const installed = await f.call("skills.install", { suite, targets: ["codex", "claude"] });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.ok((installed.body as any).results.every((result: any) => result.ok));
  for (const target of ["codex", "claude"]) assert.ok(fs.existsSync(path.join(f.directory, `.${target}`, "skills", "local-check", "SKILL.md")));
  const listed = await f.call("skills.suites");
  assert.ok((listed.body as any).suites.some((item: any) => item.suiteId === suite.suiteId));
  const removed = await f.call("skills.uninstall", { suiteId: suite.suiteId, targets: ["codex", "claude"] });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.ok((removed.body as any).results.every((result: any) => result.ok));
  for (const target of ["codex", "claude"]) assert.equal(fs.existsSync(path.join(f.directory, `.${target}`, "skills", "local-check")), false);
});

test("desktop platform Skill install keeps asset ownership and package persistence", async t => {
  const f = fixture(t);
  const saved = await f.call("orch.skills.upsert", { skill: { id: "local-skill", name: "Local Skill", kind: "custom", description: "本机技能", trigger: "检查时使用", instructions: "执行检查", targetEngines: ["codex"], files: [
    { relPath: "SKILL.md", kind: "skill-md", contentText: "---\nname: local-skill\ndescription: 本机技能\n---\n执行检查。" },
  ] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const skillId = (saved.body as any).skill.id;
  assert.equal((await f.call("orch.skills.installStatus", { skillId })).status, 200);
  assert.equal((await f.call("orch.skills.install", { skillId, targets: ["codex"] })).status, 200);
  const status = await f.call("orch.skills.installStatus", { skillId });
  assert.equal((status.body as any).status.find((item: any) => item.targetId === "codex").installed, true);
  assert.equal((await f.call("orch.skills.uninstall", { skillId, targets: ["codex"] })).status, 200);
  assert.equal((await f.call("orch.skills.install", { skillId: "missing", targets: ["codex"] })).status, 404);
});
