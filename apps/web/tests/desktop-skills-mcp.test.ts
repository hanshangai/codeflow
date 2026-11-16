import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApiRequest, WorkspaceId } from "@codeflowai/shared";
import * as api from "../src/api/skills/index.ts";
import { getOrchSkillInstallStatus, installOrchSkillPackage, uninstallOrchSkillPackage } from "../src/api/orchestration/index.ts";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";

const mutations = [
  ["/api/skills/install", "skills.install"], ["/api/skills/uninstall", "skills.uninstall"],
  ...["install", "enable", "update", "test", "import", "uninstall", "configure", "unconfigure"].map(action => [`/api/mcp/${action}`, `mcp.${action}`]),
  ["/api/orch/skills/install", "orch.skills.install"], ["/api/orch/skills/uninstall", "orch.skills.uninstall"],
];

test("Skill and MCP APIs use the desktop bridge without login or Server", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), requests: DesktopApiRequest[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => { requests.push(request); return { status: 200, body: { ok: true } }; },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected Server request"); });
  const ctx = { serverWsOrigin: "", sessionToken: null, webSessionId: null, desktopClientId: "local",
    ensureSession: async () => { throw new Error("Unexpected login request"); } };
  const workspaceId = "local:workspace" as WorkspaceId;
  await api.getSkillSuites(ctx, workspaceId, { includeMcpStatus: true });
  await api.installSkills(ctx, { workspaceId, suiteId: "suite", targets: ["codex"] });
  await api.uninstallSkills(ctx, { workspaceId, suiteId: "suite", targets: ["codex"] });
  const body = { workspaceId, mcpId: "mcp", engine: "codex" as const };
  await api.installMcpServer(ctx, body); await api.enableMcpServer(ctx, body); await api.updateMcpServer(ctx, body);
  await api.testMcpServer(ctx, body); await api.importMcpServers(ctx, { workspaceId, sources: ["vscode"] });
  await api.uninstallMcpServer(ctx, body); await api.configureMcpServer(ctx, body); await api.unconfigureMcpServer(ctx, body);
  await getOrchSkillInstallStatus(ctx, { workspaceId, skillId: "skill" as any });
  await installOrchSkillPackage(ctx, { workspaceId, skillId: "skill" as any, targets: ["codex"] });
  await uninstallOrchSkillPackage(ctx, { workspaceId, skillId: "skill" as any, targets: ["codex"] });
  assert.deepEqual(requests.map(request => request.method), ["skills.suites", ...mutations.slice(0, 10).map(([, method]) => method), "orch.skills.installStatus", "orch.skills.install", "orch.skills.uninstall"]);
  assert.deepEqual(requests[0]?.body, { workspaceId, includeMcpStatus: true });
  assert.ok(requests.every(request => request.body?.workspaceId === workspaceId));
});

test("Skill and MCP mappings preserve remote scope and reject ambiguous local targets", () => {
  for (const [path, method] of mutations) {
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId: "local:workspace" } }, "local"), { method, body: { workspaceId: "local:workspace" } });
    for (const workspaceId of ["shared:team", "remote:workspace", ""]) {
      assert.equal(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId } }, "local"), null);
    }
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: `${path}?workspaceId=remote%3Aworkspace`, body: { workspaceId: "local:workspace" } }, "local"), null);
  }
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/skills/suites?workspaceId=remote%3Aworkspace" }, "local"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/skills/suites" }, "local"), null);
});
