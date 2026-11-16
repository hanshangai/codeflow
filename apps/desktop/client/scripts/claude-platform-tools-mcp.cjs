#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const registryPath = String(process.env.CODEFLOWAI_PLATFORM_TOOLS_REGISTRY_PATH || "").trim();
const bridgeUrl = String(process.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL || "").trim();
const bridgeToken = String(process.env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN || "").trim();

const state = {
  tools: [],
};

main();

/** 启动最小 MCP stdio server，向 Claude 暴露本轮平台工具。 */
function main() {
  state.tools = loadTools();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line);
  });
}

/** 读取父进程写入的临时平台工具注册表。 */
function loadTools() {
  if (!registryPath) throw new Error("CODEFLOWAI_PLATFORM_TOOLS_REGISTRY_PATH is required");
  if (!bridgeUrl) throw new Error("CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL is required");
  if (!bridgeToken) throw new Error("CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN is required");

  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const tools = Array.isArray(parsed && parsed.tools) ? parsed.tools : [];
  return tools.map((tool) => ({
    name: String(tool.name || "").trim(),
    description: String(tool.description || "").trim(),
    inputSchema: tool.inputSchema || { type: "object", additionalProperties: true },
  })).filter((tool) => tool.name);
}

/** 处理 MCP JSON-RPC 单行请求。 */
async function handleLine(line) {
  const text = String(line || "").trim();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    writeResponse(null, null, buildJsonRpcError(-32700, errorMessage(error)));
    return;
  }

  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const method = String(message.method || "").trim();
  if (id === undefined) {
    return;
  }

  try {
    if (method === "initialize") {
      writeResponse(id, {
        protocolVersion: String((message.params && message.params.protocolVersion) || "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "codeflowai-platform-tools", version: "1.0.0" },
      });
      return;
    }

    if (method === "tools/list") {
      writeResponse(id, {
        tools: state.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const result = await callBridge(message.params || {});
      writeResponse(id, result);
      return;
    }

    writeResponse(id, null, buildJsonRpcError(-32601, `Unsupported method: ${method}`));
  } catch (error) {
    writeResponse(id, null, buildJsonRpcError(-32000, errorMessage(error)));
  }
}

/** 通过父进程本地 bridge 执行真实 host-managed tool。 */
async function callBridge(params) {
  const name = String(params.name || "").trim();
  if (!name) {
    return buildToolCallResult({
      ok: false,
      code: "BAD_REQUEST",
      message: "tools/call missing params.name",
    });
  }

  let response;
  try {
    response = await fetch(`${bridgeUrl}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeToken}`,
      },
      body: JSON.stringify({
        name,
        arguments: params.arguments || {},
      }),
    });
  } catch (error) {
    return buildToolCallResult({
      ok: false,
      code: "BRIDGE_UNAVAILABLE",
      message: errorMessage(error),
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    payload = {
      ok: false,
      code: "BAD_BRIDGE_RESPONSE",
      message: errorMessage(error),
    };
  }

  if (!response.ok && payload && typeof payload === "object") {
    payload.ok = false;
    payload.code = payload.code || `HTTP_${response.status}`;
  }
  return buildToolCallResult(payload);
}

/** 将平台工具执行结果转换为 MCP tools/call 返回。 */
function buildToolCallResult(result) {
  const normalized = result && typeof result === "object"
    ? result
    : { ok: false, code: "BAD_RESULT", message: "Invalid bridge result" };
  return {
    content: [{
      type: "text",
      text: JSON.stringify(normalized, null, 2),
    }],
    isError: normalized.ok !== true,
  };
}

function writeResponse(id, result, error) {
  const payload = {
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function buildJsonRpcError(code, message) {
  return { code, message };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
