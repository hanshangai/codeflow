import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { EngineCustomModelRepo } from "../../apps/desktop/client/src/db/repos/engineCustomModelRepo.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { assertClientReasoningEffortSupported } from "../../apps/desktop/client/src/engines/engineModelCapabilities.ts";
import { resetEngineModelCatalogRuntimeForTest, setEngineModelCatalogCustomModels } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";

test.afterEach(() => resetEngineModelCatalogRuntimeForTest());

function withRepo(fn: (repo: EngineCustomModelRepo) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-engine-model-repo-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  try {
    migrateClientDb(db as any);
    fn(new EngineCustomModelRepo(db as any));
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("EngineCustomModelRepo inserts and resolves custom model metadata", () => {
  withRepo((repo) => {
    const created = repo.insert({
      engine: "claude",
      providerId: "moonshot",
      modelId: "moonshot-k2-0711",
      displayName: "Moonshot K2",
      inputModalities: ["text", "image"],
      contextWindow: 200_000,
      enabled: true,
    });

    assert.equal(created.modelId, "moonshot-k2-0711");
    assert.equal(created.providerId, "moonshot");
    assert.deepEqual(created.inputModalities, ["text", "image"]);
    assert.equal(repo.getByEngineModel("claude", "moonshot-k2-0711")?.id, created.id);
    assert.deepEqual(repo.listEnabledByEngine("claude").map((item) => item.modelId), ["moonshot-k2-0711"]);
  });
});

test("EngineCustomModelRepo keeps empty effort as no-effort metadata", () => {
  withRepo((repo) => {
    const created = repo.insert({
      engine: "codex",
      providerId: "openai",
      modelId: "vendor/no-effort",
      displayName: "Vendor No Effort",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    });

    assert.deepEqual(created.supportedReasoningEfforts, []);
    assert.equal(created.defaultReasoningEffort, null);
  });
});

test("EngineCustomModelRepo persists configured effort metadata", () => {
  withRepo((repo) => {
    const created = repo.insert({
      engine: "codex",
      providerId: "openai",
      modelId: "vendor/reasoning",
      displayName: "Vendor Reasoning",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      supportsFastMode: true,
    });

    assert.deepEqual(created.supportedReasoningEfforts.map((item) => item.reasoningEffort), ["low", "high"]);
    assert.equal(created.defaultReasoningEffort, "high");
    assert.equal(created.supportsFastMode, true);
  });
});

test("Client effort validation resolves custom model 1M aliases through base metadata", () => {
  withRepo(() => {
    setEngineModelCatalogCustomModels([
      {
        id: "test:claude:vendor/custom-long-context",
        engine: "claude",
        providerId: "anthropic",
        modelId: "vendor/custom-long-context",
        displayName: "Custom Long Context",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }],
        defaultReasoningEffort: "low",
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
        supportsFastMode: false,
        supports1MContext: true,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "test:claude:vendor/custom-fixed-1m",
        engine: "claude",
        providerId: "anthropic",
        modelId: "vendor/custom-fixed-1m",
        displayName: "Custom Fixed 1M",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
        defaultReasoningEffort: "high",
        contextWindow: 1_000_000,
        maxContextWindow: null,
        supportsFastMode: false,
        supports1MContext: true,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const capabilityDb = {};

    assert.doesNotThrow(() => assertClientReasoningEffortSupported(
      capabilityDb,
      "claude",
      "vendor/custom-long-context[1m]",
      "low",
    ));
    assert.throws(
      () => assertClientReasoningEffortSupported(
        capabilityDb,
        "claude",
        "vendor/custom-long-context[1m]",
        "high",
      ),
      /vendor\/custom-long-context.*high/,
    );

    assert.doesNotThrow(() => assertClientReasoningEffortSupported(
      capabilityDb,
      "claude",
      "vendor/custom-fixed-1m[1m]",
      "high",
    ));
    assert.throws(
      () => assertClientReasoningEffortSupported(
        capabilityDb,
        "claude",
        "vendor/custom-fixed-1m[1m]",
        "low",
      ),
      /vendor\/custom-fixed-1m.*low/,
    );
  });
});

test("EngineCustomModelRepo rejects built-in and invalid provider definitions", () => {
  withRepo((repo) => {
    assert.throws(
      () => repo.insert({
        engine: "codex",
        providerId: "openai",
        modelId: "gpt-6.2-sol",
        displayName: "Duplicate Builtin",
      }),
      /内置目录/,
    );
    assert.throws(
      () => repo.insert({
        engine: "codex",
        providerId: "deepseek" as any,
        modelId: "deepseek-on-codex",
        displayName: "Bad Provider",
      }),
      /供应商不支持当前引擎/,
    );
  });
});

test("EngineCustomModelRepo accepts current Codex efforts and rejects unsupported provider metadata", () => {
  withRepo((repo) => {
    const created = repo.insert({
      engine: "codex",
      providerId: "openai",
      modelId: "vendor/codex-ultra",
      displayName: "Codex Ultra",
      supportedReasoningEfforts: ["max", "ultra"],
      defaultReasoningEffort: "ultra",
    });
    assert.deepEqual(created.supportedReasoningEfforts.map((item) => item.reasoningEffort), ["max", "ultra"]);
    assert.equal(created.defaultReasoningEffort, "ultra");
    const deepseek = repo.insert({
      engine: "claude",
      providerId: "deepseek",
      modelId: "vendor/deepseek-reasoning",
      displayName: "DeepSeek Reasoning",
      supportedReasoningEfforts: ["low", "max"],
      defaultReasoningEffort: "max",
    });
    assert.deepEqual(deepseek.supportedReasoningEfforts.map((item) => item.reasoningEffort), ["low", "max"]);
    assert.equal(deepseek.defaultReasoningEffort, "max");
    assert.throws(
      () => repo.insert({
        engine: "claude",
        providerId: "deepseek",
        modelId: "vendor/deepseek-medium",
        displayName: "Bad DeepSeek Medium",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      }),
      /deepseek 不支持思考强度 medium/,
    );
    assert.throws(
      () => repo.insert({
        engine: "claude",
        providerId: "qwen",
        modelId: "vendor/qwen-high",
        displayName: "Bad Qwen High",
        supportedReasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      }),
      /qwen 不支持思考强度 high/,
    );
  });
});
