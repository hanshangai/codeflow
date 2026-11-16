import test from "node:test";
import assert from "node:assert/strict";

import { parseMcpImportSourceContent } from "../../apps/desktop/client/src/skills/mcpImporter.ts";

test("Claude JSON 导入应识别本地命令并忽略环境变量明文", () => {
  const result = parseMcpImportSourceContent("claude", "C:/temp/.claude.json", JSON.stringify({
    mcpServers: {
      docs: {
        command: "team-docs",
        args: ["--stdio"],
        env: { SECRET_TOKEN: "should-not-return" },
      },
    },
  }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0]?.installType, "local-command");
  assert.equal(result.items[0]?.command, "team-docs");
  assert.deepEqual(result.items[0]?.prerequisites, ["导入配置中的环境变量需在高级配置中补充"]);
  assert.doesNotMatch(JSON.stringify(result), /should-not-return/);
});

test("VS Code JSON 导入应识别远程 HTTP MCP", () => {
  const result = parseMcpImportSourceContent("vscode", "C:/temp/mcp.json", JSON.stringify({
    servers: { remoteDocs: { type: "http", url: "https://example.com/mcp" } },
  }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0]?.installType, "http");
  assert.equal(result.items[0]?.transportType, "streamable-http");
  assert.equal(result.items[0]?.npmPackage, null);
});

test("导入远程地址和参数时应移除凭据并提示补充认证", () => {
  const result = parseMcpImportSourceContent("claude", "C:/temp/.claude.json", JSON.stringify({
    mcpServers: {
      remoteDocs: {
        url: "https://user:password@example.com/mcp?api_key=secret&region=cn",
        headers: { Authorization: "Bearer secret" },
        args: ["--region", "cn", "--token", "secret"],
      },
    },
  }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0]?.url, "https://example.com/mcp?region=cn");
  assert.deepEqual(result.items[0]?.args, ["--region", "cn"]);
  assert.match(result.items[0]?.prerequisites?.join(";") ?? "", /认证信息已隐藏/);
  assert.doesNotMatch(JSON.stringify(result), /secret|password/i);
});

test("导入远程地址时应移除 key、sig、signature 和 jwt 参数", () => {
  const result = parseMcpImportSourceContent("vscode", "C:/temp/mcp.json", JSON.stringify({
    servers: {
      signedDocs: {
        type: "http",
        url: "https://example.com/mcp?key=one&sig=two&signature=three&jwt=four&region=cn",
      },
    },
  }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0]?.url, "https://example.com/mcp?region=cn");
  assert.match(result.items[0]?.prerequisites?.join(";") ?? "", /认证信息已隐藏/);
  assert.doesNotMatch(JSON.stringify(result), /one|two|three|four/);
});

test("导入身份应包含工作区作用域，避免同名配置互相覆盖", () => {
  const content = JSON.stringify({ mcpServers: { docs: { command: "team-docs" } } });
  const first = parseMcpImportSourceContent("claude", "C:/temp/.claude.json", content, "workspace-a");
  const second = parseMcpImportSourceContent("claude", "C:/temp/.claude.json", content, "workspace-b");
  assert.notEqual(first.items[0]?.mcpId, second.items[0]?.mcpId);
  assert.equal(first.items[0]?.workspaceScope, "workspace-a");
  assert.equal(second.items[0]?.workspaceScope, "workspace-b");
});

test("Codex TOML 导入应解析 server 名称、命令和参数", () => {
  const result = parseMcpImportSourceContent("codex", "C:/temp/config.toml", [
    "[mcp_servers.context7]",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
  ].join("\n"));
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0]?.serverName, "context7");
  assert.deepEqual(result.items[0]?.args, ["-y", "@upstash/context7-mcp"]);
});

test("Codex TOML 导入应识别多行参数数组", () => {
  const result = parseMcpImportSourceContent("codex", "C:/temp/config.toml", [
    "[mcp_servers.context7]",
    'command = "npx"',
    "args = [",
    '  "-y",',
    '  "@upstash/context7-mcp"',
    "] # comment",
  ].join("\n"));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.items[0]?.args, ["-y", "@upstash/context7-mcp"]);
});

test("Docker 可执行文件应拒绝导入，但普通参数中的 docker 不应误判", () => {
  const docker = parseMcpImportSourceContent("cursor", "C:/temp/mcp.json", JSON.stringify({
    mcpServers: { dockerTool: { command: "/usr/bin/docker", args: ["run", "tool-image"] } },
  }));
  const regular = parseMcpImportSourceContent("cursor", "C:/temp/mcp.json", JSON.stringify({
    mcpServers: { regularTool: { command: "team-tool", args: ["--runtime", "docker"] } },
  }));
  assert.equal(docker.items.length, 0);
  assert.match(docker.errors[0]?.message ?? "", /Docker/);
  assert.equal(regular.errors.length, 0);
  assert.equal(regular.items[0]?.command, "team-tool");
});

test("Docker MCP 导入应明确拒绝且不返回成功条目", () => {
  const result = parseMcpImportSourceContent("cursor", "C:/temp/mcp.json", JSON.stringify({
    mcpServers: { dockerTool: { command: "docker", args: ["run", "tool-image"] } },
  }));
  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Docker/);
});
