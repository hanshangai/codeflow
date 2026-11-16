import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { ExecutableToolRegistry } from "../../packages/shared/src/index.ts";
import { ToolRuntimeService } from "../../apps/desktop/client/src/orchestration/toolRuntimeService.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import {
  buildClaudePlatformToolNameByToolId,
  buildClaudePlatformToolSpecs,
  CLAUDE_PLATFORM_MCP_SERVER_NAME,
  createClaudePlatformToolBridge,
  isClaudePlatformToolName,
} from "../../apps/desktop/client/src/engines/claude/claudePlatformTools.ts";

function createToolRegistry(): ExecutableToolRegistry {
  return {
    tools: [{
      toolsetId: "__runtime_submit__" as any,
      toolsetName: "内建编排提交",
      toolId: "runtime.submitNodeResult" as any,
      name: "提交节点结果",
      alias: null,
      description: "提交节点结果",
      runtime: "builtin",
      usageGuidance: "只能在节点结果完整后调用",
      invocationHint: "{\"answer\":{}}",
      code: "",
      inputSchema: "{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"object\"}}}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: true,
    }, {
      toolsetId: "__runtime_collision__" as any,
      toolsetName: "冲突",
      toolId: "runtime.submitNodeResult!" as any,
      name: "冲突提交",
      alias: null,
      description: "冲突提交",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: null,
      outputSchema: null,
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
}

test("buildClaudePlatformToolNameByToolId emits stable provider-safe names", () => {
  const names = buildClaudePlatformToolNameByToolId(createToolRegistry());

  assert.equal(names.get("runtime.submitNodeResult"), "aidt_runtime_submitNodeResult");
  assert.equal(names.get("runtime.submitNodeResult!"), "aidt_runtime_submitNodeResult_2");
  assert.match(names.get("runtime.submitNodeResult") ?? "", /^[a-zA-Z0-9_-]+$/);
});

test("buildClaudePlatformToolSpecs preserves platform id inside tool description", () => {
  const specs = buildClaudePlatformToolSpecs(createToolRegistry());

  assert.equal(specs.length, 2);
  assert.equal(specs[0]?.toolId, "runtime.submitNodeResult");
  assert.equal(specs[0]?.name, "aidt_runtime_submitNodeResult");
  assert.match(specs[0]?.description ?? "", /平台工具ID：runtime\.submitNodeResult/);
  assert.deepEqual(specs[0]?.inputSchema, {
    type: "object",
    properties: {
      answer: { type: "object" },
    },
  });
});

test("buildClaudePlatformToolSpecs rejects invalid input schema", () => {
  const registry = createToolRegistry();
  registry.tools[0]!.inputSchema = "{bad-json";

  assert.throws(
    () => buildClaudePlatformToolSpecs(registry),
    /Claude 平台工具 inputSchema 不是合法 JSON/,
  );
});

test("isClaudePlatformToolName accepts raw and Claude MCP-prefixed tool names", () => {
  const toolNames = ["aidt_runtime_submitNodeResult"];

  assert.equal(isClaudePlatformToolName("aidt_runtime_submitNodeResult", toolNames), true);
  assert.equal(isClaudePlatformToolName(`mcp__${CLAUDE_PLATFORM_MCP_SERVER_NAME}__aidt_runtime_submitNodeResult`, toolNames), true);
  assert.equal(isClaudePlatformToolName("Bash", toolNames), false);
});

test("Claude platform MCP server forwards tool calls to executeHostTool bridge", async () => {
  const calls: unknown[] = [];
  const bridge = await createClaudePlatformToolBridge({
    toolRegistry: createToolRegistry(),
    accessMode: "current",
    executeHostTool: async (input) => {
      calls.push(input);
      return {
        ok: true,
        output: { accepted: true },
      };
    },
    onFatalError(error) {
      throw error;
    },
  });
  assert.ok(bridge);

  const config = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, "utf8"));
  const serverConfig = config.mcpServers[CLAUDE_PLATFORM_MCP_SERVER_NAME];
  const child = spawn(serverConfig.command, serverConfig.args, {
    env: {
      ...process.env,
      ...serverConfig.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const responses: any[] = [];
  rl.on("line", (line) => {
    responses.push(JSON.parse(line));
  });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "aidt_runtime_submitNodeResult",
        arguments: { answer: { mode: "text", text: "ok" } },
      },
    }) + "\n");

    await waitForResponses(responses, 3);
    assert.equal(responses[0]?.result?.capabilities?.tools != null, true);
    assert.equal(responses[1]?.result?.tools?.[0]?.name, "aidt_runtime_submitNodeResult");
    assert.deepEqual(JSON.parse(responses[2]?.result?.content?.[0]?.text), {
      ok: true,
      output: { accepted: true },
    });
    assert.deepEqual(calls, [{
      toolId: "runtime.submitNodeResult",
      toolInput: { answer: { mode: "text", text: "ok" } },
      accessMode: "current",
    }]);
  } finally {
    rl.close();
    child.kill();
    await bridge.dispose();
  }
});

test("Claude platform bridge trips after five consecutive tool failures", async () => {
  const fatalErrors: Error[] = [];
  const bridge = await createClaudePlatformToolBridge({
    toolRegistry: createToolRegistry(),
    accessMode: "current",
    executeHostTool: async () => ({
      ok: false,
      message: "bad input",
      code: "VALIDATION_FAILED",
    }),
    onFatalError(error) {
      fatalErrors.push(error);
    },
  });
  assert.ok(bridge);

  const config = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, "utf8"));
  const serverConfig = config.mcpServers[CLAUDE_PLATFORM_MCP_SERVER_NAME];
  const bridgeUrl = String(serverConfig.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL);
  const token = String(serverConfig.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN);

  try {
    for (let index = 1; index <= 4; index += 1) {
      const response = await fetch(`${bridgeUrl}/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "aidt_runtime_submitNodeResult",
          arguments: {},
        }),
      });
      const payload = await response.json();
      assert.equal(payload.ok, false);
      assert.equal(fatalErrors.length, 0);
    }

    const response = await fetch(`${bridgeUrl}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: "aidt_runtime_submitNodeResult",
        arguments: {},
      }),
    });
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(fatalErrors.length, 1);
    assert.match(fatalErrors[0]?.message ?? "", /连续失败 5 次/);
  } finally {
    await bridge.dispose();
  }
});
test("Claude platform bridge resets failure count when the failed call changes", async () => {
  const fatalErrors: Error[] = [];
  const bridge = await createClaudePlatformToolBridge({
    toolRegistry: createToolRegistry(),
    accessMode: "current",
    executeHostTool: async () => ({
      ok: false,
      message: "bad input",
      code: "VALIDATION_FAILED",
    }),
    onFatalError(error) {
      fatalErrors.push(error);
    },
  });
  assert.ok(bridge);

  const config = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, "utf8"));
  const serverConfig = config.mcpServers[CLAUDE_PLATFORM_MCP_SERVER_NAME];
  const bridgeUrl = String(serverConfig.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL);
  const token = String(serverConfig.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN);

  const call = async (argumentsValue: unknown) => {
    const response = await fetch(`${bridgeUrl}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "aidt_runtime_submitNodeResult", arguments: argumentsValue }),
    });
    return response.json();
  };

  try {
    for (let index = 1; index <= 4; index += 1) await call({ value: "first" });
    await call({ value: "second" });
    assert.equal(fatalErrors.length, 0);
    for (let index = 1; index <= 4; index += 1) await call({ value: "second" });
    assert.equal(fatalErrors.length, 1);
  } finally {
    await bridge.dispose();
  }
});

function waitForResponses(responses: unknown[], count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (responses.length >= count) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 3_000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${count} MCP responses, got ${responses.length}`));
      }
    }, 25);
  });
}
