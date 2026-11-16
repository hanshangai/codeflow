import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEFLOWAI_CODEX_API_KEY_ENV,
  buildCodexAppServerConfigArgs,
  withCodexConfigWriteLock,
} from "../src/enginesConfig.ts";
import {
  buildThreadResumeRequestParams,
  buildThreadStartRequestParams,
  resolveCodexAppServerModelProvider,
} from "../src/engines/codex-app-server/codexAppServerProtocol.ts";

test("Codex app-server provider 覆盖不把 Key 放进命令行", () => {
  const args = buildCodexAppServerConfigArgs({
    apiKey: "secret-key-must-not-appear",
    baseUrl: "https://switchbase.example/v1",
  });

  assert.ok(args.length > 0);
  assert.match(args.join(" "), /model_provider=\"codeflowai\"/);
  assert.match(args.join(" "), /model_providers\.codeflowai\.base_url/);
  assert.ok(args.includes(`model_providers.codeflowai.env_key="${CODEFLOWAI_CODEX_API_KEY_ENV}"`));
  assert.match(args.join(" "), /requires_openai_auth=false/);
  assert.doesNotMatch(args.join(" "), /OPENAI_API_KEY/);
  assert.doesNotMatch(args.join(" "), /secret-key-must-not-appear/);
});

test("无 Base URL 时不生成共享 provider 覆盖", () => {
  assert.deepEqual(buildCodexAppServerConfigArgs({ apiKey: "key", baseUrl: null }), []);
  assert.deepEqual(buildCodexAppServerConfigArgs(null), []);
});

test("Codex thread 启动和恢复使用 app-server provider 名称而非逻辑 provider ID", () => {
  assert.equal(resolveCodexAppServerModelProvider({ baseUrl: "https://switchbase.example/v1" }), "codeflowai");
  assert.equal(resolveCodexAppServerModelProvider({ baseUrl: null }), "openai");
  assert.equal(resolveCodexAppServerModelProvider(null), null);

  const start = buildThreadStartRequestParams({
    cwd: "Z:/code/aidt-code",
    accessMode: "full-access",
    modelProvider: "codeflowai",
    developerInstructions: "角色规则与输出约束",
  });
  const resume = buildThreadResumeRequestParams({
    threadId: "provider-thread",
    cwd: "Z:/code/aidt-code",
    accessMode: "full-access",
    modelProvider: "codeflowai",
    developerInstructions: "角色规则与输出约束",
  });
  assert.equal(start.modelProvider, "codeflowai");
  assert.equal(resume.modelProvider, "codeflowai");
  assert.equal(start.developerInstructions, "角色规则与输出约束");
  assert.equal(resume.developerInstructions, "角色规则与输出约束");
});

test("Codex 新建和恢复会话均开启普通模式提问且保留上下文配置", () => {
  for (const context of [{}, { contextWindow: 300_000, autoCompactPct: 95 }]) {
    const options = { cwd: "Z:/code/aidt-code", accessMode: "current" as const, ...context };
    const expected = {
      "features.default_mode_request_user_input": true,
      ...("contextWindow" in context ? { model_context_window: 300_000, model_auto_compact_token_limit: 285_000 } : {}),
    };
    assert.deepEqual(buildThreadStartRequestParams(options).config, expected);
    assert.deepEqual(buildThreadResumeRequestParams({ ...options, threadId: "provider-thread" }).config, expected);
  }
});

test("Codex 配置写入锁按提交顺序执行", async () => {
  const events: string[] = [];
  const first = withCodexConfigWriteLock(async () => {
    events.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("first-end");
  });
  const second = withCodexConfigWriteLock(async () => {
    events.push("second-start");
    events.push("second-end");
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});
