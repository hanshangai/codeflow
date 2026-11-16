import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import {
  listCodexSkillInputActions,
  normalizeCodexSkillPath,
  resolveCodexSkillMentionBindings,
} from "../src/engines/codex-app-server/codexInputActions.ts";

const WORKSPACE_ID = "client-test:skill-actions" as WorkspaceId;
const HMAC_KEY = Buffer.alloc(32, 7);

/** 构造单工作区 skills/list requester，并保留真实请求参数供断言。 */
function createRequester(workspacePath: string, skills: unknown[], errors: unknown[] = []) {
  const calls: Array<{ method: string; params: unknown; opts: unknown }> = [];
  return {
    calls,
    requester: {
      async request(method: string, params: unknown, opts: unknown) {
        calls.push({ method, params, opts });
        return { data: [{ cwd: workspacePath, skills, errors }] };
      },
    },
  };
}

test("Codex Skill catalog 隐藏路径、跳过不可用项并保留 partial warning", async () => {
  const workspacePath = path.resolve("Z:/code/aidt-code");
  const skillPath = path.join(workspacePath, ".codex", "skills", "Review", "SKILL.md");
  const { requester, calls } = createRequester(workspacePath, [
    {
      name: "review",
      path: skillPath,
      scope: "repo",
      enabled: true,
      interface: {
        displayName: `Review at ${skillPath}`,
        shortDescription: `Use ${skillPath} for review`,
      },
    },
    { name: "disabled", path: skillPath, scope: "repo", enabled: false },
  ], [{ message: `failed at ${skillPath}` }]);

  const result = await listCodexSkillInputActions({
    requester,
    workspaceId: WORKSPACE_ID,
    workspacePath,
    hmacKey: HMAC_KEY,
    expectedProcessGeneration: 9,
  });

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.kind, "codex-skill");
  assert.equal((result.actions[0] as any).token, "$review");
  assert.doesNotMatch(JSON.stringify(result), /Review[\\/]SKILL\.md/u);
  assert.match(result.providerCatalog.message ?? "", /1 项发现错误/u);
  assert.match(result.providerCatalog.message ?? "", /1 个不可用候选/u);
  assert.deepEqual(calls[0], {
    method: "skills/list",
    params: { cwds: [workspacePath], forceReload: true },
    opts: { timeoutMs: 10_000, expectedProcessGeneration: 9 },
  });
});

test("Codex Skill HMAC 在 Windows 按大小写无关路径稳定，但发送保留 Provider 路径", async () => {
  const workspacePath = path.resolve("Z:/code/aidt-code");
  const providerPath = path.join(workspacePath, "Skills", "CaseSensitiveName", "SKILL.md");
  const first = createRequester(workspacePath, [{
    name: "case-skill",
    path: providerPath,
    scope: "repo",
    enabled: true,
  }]);
  const listed = await listCodexSkillInputActions({
    requester: first.requester,
    workspaceId: WORKSPACE_ID,
    workspacePath,
    hmacKey: HMAC_KEY,
  });
  const action = listed.actions[0] as Extract<(typeof listed.actions)[number], { kind: "codex-skill" }>;
  const binding = { skillId: action.skillId, name: action.name, start: 4, end: 15 };
  const resolved = await resolveCodexSkillMentionBindings({
    requester: first.requester,
    workspaceId: WORKSPACE_ID,
    workspacePath,
    hmacKey: HMAC_KEY,
    text: "use $case-skill",
    bindings: [binding],
    expectedProcessGeneration: 3,
  });

  assert.equal(normalizeCodexSkillPath(providerPath), path.normalize(providerPath));
  assert.equal(resolved[0]?.path, path.normalize(providerPath));

  if (process.platform === "win32") {
    const second = createRequester(workspacePath, [{
      name: "case-skill",
      path: providerPath.toLowerCase(),
      scope: "repo",
      enabled: true,
    }]);
    const relisted = await listCodexSkillInputActions({
      requester: second.requester,
      workspaceId: WORKSPACE_ID,
      workspacePath,
      hmacKey: HMAC_KEY,
    });
    assert.equal((relisted.actions[0] as any).skillId, action.skillId);
  }
});

test("Codex Skill fresh resolve 显式拒绝失效 binding 和全量发现失败", async () => {
  const workspacePath = path.resolve("Z:/code/aidt-code");
  const skillPath = path.join(workspacePath, ".codex", "skills", "review", "SKILL.md");
  const valid = createRequester(workspacePath, [{
    name: "review",
    path: skillPath,
    scope: "repo",
    enabled: true,
  }]);
  await assert.rejects(
    () => resolveCodexSkillMentionBindings({
      requester: valid.requester,
      workspaceId: WORKSPACE_ID,
      workspacePath,
      hmacKey: HMAC_KEY,
      text: "use $review",
      bindings: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", start: 4, end: 11 }],
      expectedProcessGeneration: 1,
    }),
    (error: any) => error?.code === "CODEX_SKILL_BINDING_INVALID",
  );

  const failed = createRequester(workspacePath, [], [{ message: skillPath }]);
  await assert.rejects(
    () => listCodexSkillInputActions({
      requester: failed.requester,
      workspaceId: WORKSPACE_ID,
      workspacePath,
      hmacKey: HMAC_KEY,
    }),
    (error: any) => error?.code === "THREAD_INPUT_ACTION_CATALOG_FAILED"
      && !String(error?.message ?? "").includes(skillPath),
  );
});
