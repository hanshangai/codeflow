import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  EngineModelCatalogValidationError,
  engineModelCatalogRowsToModelInfo,
  serializeEngineModelCatalogDigestPayload,
  parseEngineModelCatalogAppliedAck,
  validateEngineModelCatalogRows,
  type EngineModelCatalogItem,
} from "@codeflowai/shared";

function row(input: Partial<EngineModelCatalogItem> & Pick<EngineModelCatalogItem, "catalogItemId" | "engine" | "modelId" | "sortOrder">): EngineModelCatalogItem {
  const claude = input.engine === "claude";
  return {
    catalogItemId: input.catalogItemId,
    engine: input.engine,
    providerId: input.providerId ?? (claude ? "anthropic" : "openai"),
    providerLabel: input.providerLabel ?? (claude ? "Anthropic Claude" : "OpenAI"),
    modelId: input.modelId,
    displayName: input.displayName ?? input.modelId,
    description: input.description ?? "",
    inputModalities: input.inputModalities ?? ["text"],
    supportedReasoningEfforts: input.supportedReasoningEfforts ?? [{ reasoningEffort: "high", description: "深度思考" }],
    defaultReasoningEffort: input.defaultReasoningEffort === undefined ? "high" : input.defaultReasoningEffort,
    contextWindow: input.contextWindow ?? 200_000,
    maxContextWindow: input.maxContextWindow ?? null,
    supportsFastMode: input.supportsFastMode ?? false,
    supports1MContext: input.supports1MContext ?? false,
    isDefault: input.isDefault ?? true,
    sortOrder: input.sortOrder,
    runtimeProfileId: input.runtimeProfileId ?? "native",
    transportModelId: input.transportModelId ?? null,
    fastTaskModelId: input.fastTaskModelId ?? null,
    subagentModelId: input.subagentModelId ?? null,
  };
}

test("完整模型目录按引擎和 sortOrder 归一化", () => {
  const rows = validateEngineModelCatalogRows([
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1, supportsFastMode: true }),
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
  ]);
  assert.deepEqual(rows.map((item) => item.catalogItemId), ["claude-1", "codex-1"]);
  assert.deepEqual(engineModelCatalogRowsToModelInfo(rows, "codex").map((item) => item.id), ["gpt-6"]);
});

test("拒绝重复模型、缺少默认项和不连续供应商分组", () => {
  const rows = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "same", sortOrder: 1, isDefault: false }),
    row({ catalogItemId: "claude-2", engine: "claude", modelId: "SAME", sortOrder: 2, providerId: "deepseek", providerLabel: "DeepSeek", isDefault: false }),
    row({ catalogItemId: "claude-3", engine: "claude", modelId: "third", sortOrder: 3, isDefault: false }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  assert.throws(() => validateEngineModelCatalogRows(rows), (error: unknown) => {
    assert.ok(error instanceof EngineModelCatalogValidationError);
    assert.ok(error.issues.some((issue) => issue.message.includes("不能重复")));
    assert.ok(error.issues.some((issue) => issue.message.includes("默认模型")));
    assert.ok(error.issues.some((issue) => issue.message.includes("连续排列")));
    return true;
  });
});

test("分层运行档案要求三类传输 ID，1M 上限必须严格增大", () => {
  const invalid = row({
    catalogItemId: "claude-tiered",
    engine: "claude",
    modelId: "deepseek-v4-pro",
    sortOrder: 1,
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    runtimeProfileId: "claude_compatible_tiered",
    transportModelId: "deepseek-v4-pro[1m]",
    supports1MContext: true,
    maxContextWindow: 200_000,
  });
  assert.throws(() => validateEngineModelCatalogRows([invalid, row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 })]), /分层运行档案|扩展上下文/);
});

test("默认上下文本身达到 1M 时允许最大窗口与默认窗口相等", () => {
  assert.doesNotThrow(() => validateEngineModelCatalogRows([
    row({
      catalogItemId: "codex-1050k",
      engine: "codex",
      modelId: "gpt-6-sol",
      sortOrder: 1,
      contextWindow: 1_050_000,
      maxContextWindow: 1_050_000,
      supports1MContext: true,
    }),
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
  ]));
});

test("上下文窗口拒绝超过 PostgreSQL INTEGER 上限的值", () => {
  const invalid = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1, contextWindow: 2_147_483_648 }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  assert.throws(() => validateEngineModelCatalogRows(invalid), /2147483647/);
});

test("最大上下文不能小于默认值；计费阈值独立于默认值并传递给模型信息", () => {
  const rows = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  const model = rows.find((row) => row.engine === "codex")!;
  model.contextWindow = 200_000;
  model.maxContextWindow = 900_000;
  model.doubleBillingThreshold = 272_000;
  const parsed = validateEngineModelCatalogRows(rows);
  assert.equal(parsed.find((row) => row.catalogItemId === model.catalogItemId)?.doubleBillingThreshold, 272_000);
  assert.equal(engineModelCatalogRowsToModelInfo(parsed, "codex").find((row) => row.id === model.modelId)?.doubleBillingThreshold, 272_000);
  model.maxContextWindow = 100_000;
  assert.throws(() => validateEngineModelCatalogRows(rows), /不能小于/);
  model.maxContextWindow = 900_000;
  model.doubleBillingThreshold = -1;
  assert.throws(() => validateEngineModelCatalogRows(rows), EngineModelCatalogValidationError);
});

test("v1 摘要兼容忽略计费展示字段的旧 Client，并继续校验版本与执行参数", () => {
  const snapshot = {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 2, capturedAt: 1,
    rows: [
      row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
      row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
    ],
  };
  const legacyPayload = serializeEngineModelCatalogDigestPayload(snapshot);
  snapshot.rows[1]!.doubleBillingThreshold = 272_000;
  assert.equal(serializeEngineModelCatalogDigestPayload(snapshot), legacyPayload);
  snapshot.configVersion += 1;
  assert.notEqual(serializeEngineModelCatalogDigestPayload(snapshot), legacyPayload);
  snapshot.configVersion -= 1;
  snapshot.rows[1]!.contextWindow = 300_000;
  assert.notEqual(serializeEngineModelCatalogDigestPayload(snapshot), legacyPayload);
});

test("摘要序列化不受 capturedAt 影响", () => {
  const rows = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  const first = serializeEngineModelCatalogDigestPayload({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 2, capturedAt: 1, rows });
  const second = serializeEngineModelCatalogDigestPayload({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 2, capturedAt: 999, rows });
  assert.equal(first, second);
});

test("Claude 后台上下文遵守当前 CLI 的 100K 到 1M 范围", () => {
  const claude = row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 });
  const codex = row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 });
  for (const window of [50_000, 1_050_000]) {
    assert.throws(() => validateEngineModelCatalogRows([{ ...claude, contextWindow: window, maxContextWindow: window }, codex]), /Claude 当前支持/);
  }
});

test("边界解析把畸形 JSON 转为稳定目录校验错误", () => {
  for (const invalid of [{}, [null], [{ inputModalities: {} }]]) {
    assert.throws(() => validateEngineModelCatalogRows(invalid), EngineModelCatalogValidationError);
  }
  const invalidBoolean = [
    { ...row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }), supports1MContext: "false" },
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  assert.throws(() => validateEngineModelCatalogRows(invalidBoolean), /布尔值/);
});

test("摘要拒绝非法协议和版本，应用回执严格校验 SHA-256", () => {
  const rows = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "claude-opus", sortOrder: 1 }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  assert.throws(() => serializeEngineModelCatalogDigestPayload({ schemaVersion: "bogus", configVersion: 0, capturedAt: 1, rows }), EngineModelCatalogValidationError);
  assert.deepEqual(parseEngineModelCatalogAppliedAck({ configVersion: 2, digest: "a".repeat(64), appliedAt: 10 }), {
    configVersion: 2,
    digest: "a".repeat(64),
    appliedAt: 10,
  });
  assert.throws(() => parseEngineModelCatalogAppliedAck({ configVersion: 0, digest: "bad", appliedAt: -1 }), EngineModelCatalogValidationError);
});

test("供应商只能选择已审核的运行档案", () => {
  const invalid = [
    row({ catalogItemId: "claude-1", engine: "claude", modelId: "deepseek-v4", sortOrder: 1, providerId: "deepseek", providerLabel: "DeepSeek", runtimeProfileId: "native" }),
    row({ catalogItemId: "codex-1", engine: "codex", modelId: "gpt-6", sortOrder: 1 }),
  ];
  assert.throws(() => validateEngineModelCatalogRows(invalid), /供应商与运行档案不匹配/);
});
