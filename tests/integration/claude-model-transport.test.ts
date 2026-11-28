import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveThreadPrefsWithCatalogDefaults } from "../../packages/shared/src/index.ts";
import { buildClaudeArgs, resolveClaudeCli } from "../../apps/desktop/client/src/engines/claude/claudeCli.ts";
import { buildClaudeChildEnv } from "../../apps/desktop/client/src/engines/claude/claudeThreadSession.ts";

type CapturedRequest = {
  model: string;
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort?: string };
};

// 显式启用以避免 CI 依赖全局 CLI；全部请求只发往临时 loopback 服务，不使用真实 Key 或付费 API。
// PowerShell: $env:CODEFLOWAI_TEST_CLAUDE_CLI="1"; node --conditions=development --import tsx --test tests/integration/claude-model-transport.test.ts
test("installed Claude CLI sends supported model, context and thinking parameters", {
  skip: process.env.CODEFLOWAI_TEST_CLAUDE_CLI !== "1",
  timeout: 60_000,
}, async (t) => {
  const probeDir = await mkdtemp(path.join(tmpdir(), "codeflow-model-transport-"));
  // 只允许清理本测试创建的临时目录，禁止把工作区或临时目录根作为递归删除目标。
  assert.equal(path.dirname(probeDir), path.resolve(tmpdir()));
  assert.ok(path.basename(probeDir).startsWith("codeflow-model-transport-"));
  t.after(() => rm(probeDir, { recursive: true, force: true }));
  const cli = resolveClaudeCli();

  let requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}") as CapturedRequest & { stream?: boolean };
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (!req.url?.includes("/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }
      requests.push(body);
      const message = {
        id: "msg_transport_test", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      };
      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { type: "mock_request_invalid", message: String(error) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const model of [
      "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3",
      "glm-5.3", "glm-5.3-flash", "claude-sonnet-5",
      "claude-fable-5", "deepseek-flash[1m]",
    ]) {
      requests = [];
      const prefs = resolveThreadPrefsWithCatalogDefaults("claude", { model });
      const args = buildClaudeArgs({
        ...prefs, effort: null, text: "Reply OK only.", sessionId: null, inputFormat: "stream-json",
      });
      // 故意保留“关闭思考”设置，验证 K2.7/GLM 强制思考不会被旧设置覆盖。
      const settingsIndex = args.indexOf("--settings") + 1;
      const settings = JSON.parse(args[settingsIndex]);
      settings.alwaysThinkingEnabled = false;
      args[settingsIndex] = JSON.stringify(settings);
      args.push("--setting-sources", "", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
      const env = buildClaudeChildEnv({
        ...process.env, MAX_THINKING_TOKENS: "0", CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      }, {
        ...prefs, dangerouslySkipPermissions: false, hasConfiguredCredentials: () => true,
        readCredentials: () => ({ apiKey: "local-test-placeholder", baseUrl }),
      });
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: probeDir, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
      const child = spawn(cli.command, [...cli.argsPrefix, ...args], {
        cwd: probeDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.resume();
      const closed = once(child, "close");
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Reply OK only." }] } })}\n`);
        const [exitCode, signal] = await closed;
        assert.equal(signal, null, `${model}: CLI timed out`);
        assert.equal(exitCode, 0, `${model}: CLI failed`);
        assert.ok(requests.length > 0, `${model}: no loopback request`);
        for (const request of requests) {
          assert.equal(request.model, model.replace(/\[1m\]$/, ""));
          if (model.startsWith("kimi-k2.7") || model.startsWith("glm-5.3")) {
            assert.equal(request.thinking?.type, "enabled", `${model}: thinking type`);
            assert.ok(Number(request.thinking?.budget_tokens) > 0);
            assert.equal(request.output_config?.effort, prefs.effort ?? undefined, `${model}: effort`);
          }
        }
        const result = output.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "result");
        assert.equal(result?.subtype, "success");
        const usage = Object.values(result.modelUsage) as Array<{ contextWindow: number }>;
        assert.ok(usage.length > 0);
        assert.equal(usage[0].contextWindow, prefs.contextWindow, `${model}: effective window`);
      } finally {
        clearTimeout(timer);
        if (child.exitCode == null && child.signalCode == null) {
          child.kill();
          await closed;
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
