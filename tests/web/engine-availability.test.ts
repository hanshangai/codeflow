import test from "node:test";
import assert from "node:assert/strict";

import type { EngineProviderCredentialStatus, EngineStatus, EngineType } from "@codeflowai/shared";
import { resolveAvailableModelProviderIds, resolveEngineUnavailableIssue } from "../../apps/web/src/utils/engineAvailability.ts";

/** 构造最小 EngineStatus，避免测试依赖真实 Client 探测。 */
function buildStatus(engineType: EngineType, providerCredentialStatus: EngineProviderCredentialStatus[]): EngineStatus {
  return {
    engineType,
    installed: true,
    version: "test",
    binPath: engineType,
    features: {
      streaming: true,
      reasoning: true,
      toolUse: true,
      imageInput: true,
      sessionContinuation: true,
    },
    models: [],
    providerCredentialStatus,
    credentialStatus: providerCredentialStatus.some((provider) => provider.available)
      ? { available: true, source: providerCredentialStatus.find((provider) => provider.available)?.sources[0] ?? "codeflow_key", message: null }
      : { available: false, source: "none", message: "没有可用 provider" },
    error: null,
  };
}

test("Engine availability reports maintained but inactive key before generic credential issue", () => {
  const issue = resolveEngineUnavailableIssue("codex", buildStatus("codex", [{
    providerId: "openai",
    available: false,
    sources: [],
    message: "未检测到已启用的 OpenAI Key 或本机 Codex 原生登录",
  }]), {
    isSharedWorkspace: false,
    hasMaintainedKeys: true,
    activeProviderIds: [],
  });

  assert.equal(issue, "Codex 已维护 Key 但未启用，请到“大模型KEY设置”启用 Key。");
});

test("Engine availability allows local native Codex auth without CodeFlow key", () => {
  const status = buildStatus("codex", [{
    providerId: "openai",
    available: true,
    sources: ["local_oauth"],
    message: null,
  }]);
  const issue = resolveEngineUnavailableIssue("codex", status, {
    isSharedWorkspace: false,
    hasMaintainedKeys: false,
    activeProviderIds: [],
  });
  const availableProviderIds = resolveAvailableModelProviderIds("codex", status, {
    isSharedWorkspace: false,
    hasMaintainedKeys: false,
    activeProviderIds: [],
  });

  assert.equal(issue, null);
  assert.deepEqual(availableProviderIds, ["openai"]);
});

test("Engine availability maps local native Claude auth to Anthropic provider only", () => {
  const status = buildStatus("claude", [
    { providerId: "anthropic", available: true, sources: ["local_oauth"], message: null },
    { providerId: "deepseek", available: false, sources: [], message: "未检测到已启用的 DeepSeek Key" },
  ]);
  const availableProviderIds = resolveAvailableModelProviderIds("claude", status, {
    isSharedWorkspace: false,
    hasMaintainedKeys: false,
    activeProviderIds: [],
  });

  assert.deepEqual(availableProviderIds, ["anthropic"]);
});

test("Engine availability combines active CodeFlow providers with native provider", () => {
  const status = buildStatus("claude", [
    { providerId: "anthropic", available: true, sources: ["local_oauth"], message: null },
    { providerId: "deepseek", available: false, sources: [], message: "未检测到已启用的 DeepSeek Key" },
  ]);
  const availableProviderIds = resolveAvailableModelProviderIds("claude", status, {
    isSharedWorkspace: false,
    hasMaintainedKeys: true,
    activeProviderIds: ["deepseek"],
  });

  assert.deepEqual(new Set(availableProviderIds), new Set(["anthropic", "deepseek"]));
});
