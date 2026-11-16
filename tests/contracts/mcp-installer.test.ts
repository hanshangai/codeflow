import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeMcpRequestError } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { buildMcpBearerEnvName, createMcpMutationGuard, normalizeMcpCredentialInputs, resolveConfiguredMcpEngineLabels, resolveMcpConfiguredLabels, resolveMcpEngineServerName, resolveMcpInstanceId, resolveMcpLaunchSpec, resolveMcpRuntimeCredentialEnvironment, updateCodexMcpServerConfigText, validateMcpInstanceId } from "../../apps/desktop/client/src/skills/mcpInstaller.ts";
import { buildMcpInstanceId, buildMcpRegistryEntryKey, MCP_SERVERS_REGISTRY, normalizeMcpServerInfo, selectCustomMcpServersForWorkspace } from "../../apps/desktop/client/src/skills/mcpRegistry.ts";

test("MCP 注册表应包含 Chrome DevTools MCP", () => {
  const entry = MCP_SERVERS_REGISTRY.find((item) => item.npmPackage === "chrome-devtools-mcp");
  assert.ok(entry);
  assert.equal(entry?.mcpId, "builtin.chrome-devtools");
  assert.equal(entry?.installType, "npm");
  assert.equal(entry?.transportType, "stdio");
  assert.equal(entry?.serverName, "chrome-devtools");
  assert.match(entry?.description ?? "", /Chrome DevTools/);
});

test("MCP 实例身份应由稳定 mcpId 和配置 scope 组成", () => {
  assert.equal(buildMcpInstanceId("builtin.fetch"), "builtin.fetch::default");
  assert.equal(buildMcpInstanceId("custom.docs", "workspace-a"), "custom.docs::workspace-a");
});

test("MCP 实例校验应拒绝跨工作区和错误默认作用域", () => {
  assert.equal(validateMcpInstanceId("custom.docs", "custom.docs::workspace-a", "workspace-a"), null);
  assert.match(validateMcpInstanceId("custom.docs", "custom.docs::workspace-b", "workspace-a") ?? "", /不匹配/);
  assert.match(validateMcpInstanceId("custom.docs", "custom.docs::workspace-a", null) ?? "", /不匹配/);
  assert.equal(validateMcpInstanceId("custom.docs", null, "workspace-a"), null);
});

test("MCP 凭据输入只接受合法名称并区分环境变量和请求头", () => {
  assert.deepEqual(normalizeMcpCredentialInputs([
    { name: "GITHUB_TOKEN", value: "secret-value", kind: "env" },
    { name: "Authorization", value: "Bearer secret-value", kind: "header" },
    { name: "X-API-Key", value: "secret-value", kind: "header" },
  ]), [
    { name: "GITHUB_TOKEN", value: "secret-value", kind: "env" },
    { name: "Authorization", value: "Bearer secret-value", kind: "header" },
    { name: "X-API-Key", value: "secret-value", kind: "header" },
  ]);
  assert.throws(() => normalizeMcpCredentialInputs([{ name: "bad-name", value: "secret", kind: "env" }]));
  assert.throws(() => normalizeMcpCredentialInputs([{ name: "X-API-Key", value: "secret", kind: "env" }]));
  assert.throws(() => normalizeMcpCredentialInputs([
    { name: "TOKEN", value: "one", kind: "env" },
    { name: "TOKEN", value: "two", kind: "env" },
  ]));
});

test("MCP 状态恢复只为 Codex Bearer 生成派生环境变量", () => {
  const mcpId = "builtin.github";
  const instanceId = "builtin.github::workspace-a";
  const environment = resolveMcpRuntimeCredentialEnvironment(mcpId, instanceId, [
    { name: "GITHUB_TOKEN", value: "stdio-secret", kind: "env" },
    { name: "Authorization", value: "Bearer remote-secret", kind: "header" },
    { name: "X-API-Key", value: "header-secret", kind: "header" },
  ]);

  assert.deepEqual(environment, {
    [buildMcpBearerEnvName(mcpId, instanceId)]: "remote-secret",
  });
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.Authorization, undefined);
  assert.equal(environment["X-API-Key"], undefined);
});

test("MCP 通用错误响应应隐藏请求中的凭据值", () => {
  const message = sanitizeMcpRequestError(new Error("上游返回 request-secret"), {
    credentialInputs: [{ name: "TOKEN", value: "request-secret", kind: "env" }],
  });

  assert.equal(message, "上游返回 [REDACTED]");
  assert.doesNotMatch(message, /request-secret/);
});

test("MCP 引擎配置名应按实例作用域稳定区分", () => {
  const first = resolveMcpEngineServerName("github", "builtin.github::workspace-a");
  const second = resolveMcpEngineServerName("github", "builtin.github::workspace-b");
  assert.notEqual(first, second);
  assert.equal(first, resolveMcpEngineServerName("github", "builtin.github::workspace-a"));
});

test("已带 __cf_ 后缀的 serverName 不应再追加后缀", () => {
  const imported = "playwright__cf_0d788d009d";
  assert.equal(resolveMcpEngineServerName(imported, "imported.x::workspace-a"), imported);
  // 未带后缀的仍按实例作用域追加后缀
  assert.equal(resolveMcpEngineServerName("playwright", "builtin.playwright::Win10:ws_1f46a25f74"), "playwright__cf_0d788d009d");
});

test("MCP 实例身份缺省应按工作区作用域派生，而非默认作用域", () => {
  assert.equal(resolveMcpInstanceId({ mcpId: "custom.docs" }, null, "workspace-a"), "custom.docs::workspace-a");
  assert.equal(resolveMcpInstanceId({ mcpId: "custom.docs" }, "custom.docs::explicit", "workspace-a"), "custom.docs::explicit");
  assert.equal(resolveMcpInstanceId({ mcpId: "custom.docs" }, null, null), "custom.docs::default");
});

test("MCP 卸载保护应识别 Claude、Codex 和项目配置引用", () => {
  const configuredKeys = ["github__cf_a1b2c3d4e5", "@modelcontextprotocol/server-github"];
  assert.deepEqual(resolveConfiguredMcpEngineLabels(configuredKeys, {
    claude: new Set(["github__cf_a1b2c3d4e5"]),
    codex: new Set(["other-mcp"]),
    project: new Set(["@modelcontextprotocol/server-github"]),
  }), ["claude", "project"]);
});

test("项目 .mcp.json 中同名不同实例的 MCP 不应被误判为项目引用而阻断卸载", () => {
  const entry = { npmPackage: "@playwright/mcp", serverName: "playwright" };
  const instanceId = buildMcpInstanceId("builtin.playwright", "Win10:ws_x");
  const engineServerName = resolveMcpEngineServerName("playwright", instanceId);
  // 项目里是独立实例 Playwright（大写，带 --cdp-endpoint），Codex 才引用本实例服务名。
  const labels = resolveMcpConfiguredLabels(entry, instanceId, {
    claude: new Set(),
    codex: new Set([engineServerName]),
    project: new Set(["Playwright"]),
  });
  assert.deepEqual(labels, ["codex"]);
});

test("项目 .mcp.json 与引擎都引用同一服务名时应同时识别", () => {
  const entry = { npmPackage: "@upstash/context7-mcp", serverName: "context7" };
  const instanceId = buildMcpInstanceId("builtin.context7", "Win10:ws_x");
  const engineServerName = resolveMcpEngineServerName("context7", instanceId);
  const labels = resolveMcpConfiguredLabels(entry, instanceId, {
    claude: new Set(),
    codex: new Set([engineServerName]),
    project: new Set(["context7"]),
  });
  assert.deepEqual(labels, ["codex", "project"]);
});

test("Codex 配置里同名不同实例的 MCP 不应被误判为已接入", () => {
  const entry = { serverName: "playwright" };
  const instanceId = buildMcpInstanceId("builtin.playwright", "Win10:ws_x");
  // 配置里只有大写独立实例 Playwright + 同名 npm 包，但无本实例服务名。
  const labels = resolveMcpConfiguredLabels(entry, instanceId, {
    claude: new Set(),
    codex: new Set(["Playwright", "@playwright/mcp"]),
    project: new Set(),
  });
  assert.deepEqual(labels, []);
});

test("自定义 MCP 注册表应按工作区作用域隔离同名条目", () => {
  const global = normalizeMcpServerInfo({
    mcpId: "custom.docs",
    name: "全局文档 MCP",
    serverName: "team-docs",
    command: "team-docs",
    installType: "local-command",
  }, "custom");
  const workspaceA = normalizeMcpServerInfo({
    mcpId: "custom.docs",
    name: "A 工作区文档 MCP",
    serverName: "team-docs-a",
    command: "team-docs-a",
    installType: "local-command",
    workspaceScope: "workspace-a",
  }, "custom");
  const workspaceB = normalizeMcpServerInfo({
    mcpId: "custom.docs",
    name: "B 工作区文档 MCP",
    serverName: "team-docs-b",
    command: "team-docs-b",
    installType: "local-command",
    workspaceScope: "workspace-b",
  }, "custom");
  assert.ok(global && workspaceA && workspaceB);
  assert.notEqual(buildMcpRegistryEntryKey(workspaceA), buildMcpRegistryEntryKey(workspaceB));
  assert.deepEqual(selectCustomMcpServersForWorkspace([global, workspaceA, workspaceB], "workspace-a").map((item) => item.name), ["A 工作区文档 MCP"]);
  assert.deepEqual(selectCustomMcpServersForWorkspace([global, workspaceA, workspaceB], "workspace-b").map((item) => item.name), ["B 工作区文档 MCP"]);
});

test("推荐 MCP 应由共享目录元数据排序，而不是 Web 端包名常量", () => {
  const featured = MCP_SERVERS_REGISTRY
    .filter((item) => item.featuredRecommended)
    .sort((left, right) => (left.recommendedRank ?? Number.MAX_SAFE_INTEGER) - (right.recommendedRank ?? Number.MAX_SAFE_INTEGER));
  const recommended = MCP_SERVERS_REGISTRY
    .filter((item) => item.recommended)
    .sort((left, right) => (left.recommendedRank ?? Number.MAX_SAFE_INTEGER) - (right.recommendedRank ?? Number.MAX_SAFE_INTEGER));
  assert.deepEqual(featured.map((item) => item.serverName), ["playwright", "context7", "github"]);
  assert.deepEqual(recommended.map((item) => item.serverName), ["playwright", "context7", "github", "chrome-devtools", "fetch", "filesystem", "postgres", "gitlab", "sequential-thinking", "memory", "sentry", "brave-search", "tavily", "firecrawl", "exa", "slack"]);
  assert.equal(new Set(recommended.map((item) => item.recommendedRank)).size, recommended.length);
  for (const item of recommended) {
    assert.ok(item.categories?.length);
    assert.ok(item.prerequisites?.length);
    assert.ok(item.securityLevel);
  }
  assert.deepEqual(recommended[2]?.prerequisites, ["当前 Client 可运行 Node.js 和 npm", "需要配置 GitHub Token"]);
});

test("MCP 注册表应包含 JSHookMCP", () => {
  const entry = MCP_SERVERS_REGISTRY.find((item) => item.npmPackage === "@jshookmcp/jshook");
  assert.ok(entry);
  assert.equal(entry?.serverName, "jshookmcp");
  assert.match(entry?.homepage ?? "", /vmoranv\/jshookmcp/i);
});

test("MCP 注册表应能表达远程 HTTP、SSE、本地命令和 PyPI 条目", () => {
  const http = normalizeMcpServerInfo({
    mcpId: "custom.docs",
    name: "团队文档",
    serverName: "team-docs",
    url: "https://example.com/mcp",
    installType: "http",
    transportType: "streamable-http",
  }, "custom");
  const local = normalizeMcpServerInfo({
    mcpId: "custom.local",
    name: "本地工具",
    serverName: "local-tool",
    command: "team-tool",
    args: ["--stdio"],
    installType: "local-command",
    transportType: "stdio",
  }, "custom");
  const pypi = normalizeMcpServerInfo({
    mcpId: "custom.python",
    name: "Python 工具",
    serverName: "python-tool",
    pythonPackage: "mcp-server-fetch",
    runner: "uvx",
    installType: "pypi",
    transportType: "stdio",
  }, "custom");
  assert.equal(http?.npmPackage, null);
  assert.equal(http?.transportType, "streamable-http");
  assert.deepEqual(local?.args, ["--stdio"]);
  assert.equal(pypi?.runner, "uvx");
});

test("显式无效的 MCP 安装方式不得静默回退为 NPM", () => {
  const invalid = normalizeMcpServerInfo({
    name: "不支持的工具",
    serverName: "unsupported",
    npmPackage: "unsupported-package",
    installType: "docker" as any,
  }, "custom");
  assert.equal(invalid, null);
});

test("Docker 绝对路径不得注册为本地命令 MCP", () => {
  const invalid = normalizeMcpServerInfo({
    name: "Docker 工具",
    serverName: "docker-tool",
    command: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    installType: "local-command",
    transportType: "stdio",
  }, "custom");
  assert.equal(invalid, null);
});

test("自定义 MCP 不得把明显凭据写入命令或远程地址", () => {
  assert.equal(normalizeMcpServerInfo({
    mcpId: "custom.token-command",
    name: "带 Token 的命令",
    serverName: "token-tool",
    command: "token-tool",
    args: ["--token", "secret-value"],
    installType: "local-command",
  }, "custom"), null);
  assert.equal(normalizeMcpServerInfo({
    mcpId: "custom.key-url",
    name: "带 Key 的地址",
    serverName: "key-tool",
    url: "https://example.com/mcp?key=secret-value",
    installType: "http",
  }, "custom"), null);
  assert.ok(normalizeMcpServerInfo({
    mcpId: "custom.docker-arg",
    name: "普通 Docker 参数",
    serverName: "tool",
    command: "team-tool",
    args: ["--runtime", "docker"],
    installType: "local-command",
  }, "custom"));
});

test("Chrome DevTools MCP 在 Windows 上配置到 Codex 时应使用官方推荐的 cmd 包装与启动超时", () => {
  const spec = resolveMcpLaunchSpec("chrome-devtools", "chrome-devtools-mcp", "codex", "win32");

  assert.equal(spec.command, "cmd");
  assert.deepEqual(spec.args, ["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--isolated=true", "--channel=stable"]);
  assert.match(spec.env?.SystemRoot ?? "", /^c:\\windows$/i);
  assert.match(spec.env?.PROGRAMFILES ?? "", /^c:\\program files$/i);
  assert.equal(spec.codexStartupTimeoutMs, 20_000);
});

test("普通 MCP Server 仍应沿用通用 npx 启动规则", () => {
  const spec = resolveMcpLaunchSpec("fetch", "@modelcontextprotocol/server-fetch", "codex", "win32");

  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["-y", "@modelcontextprotocol/server-fetch"]);
  assert.equal(spec.codexStartupTimeoutMs, undefined);
});

test("更新 Codex MCP 配置时应在目标 server 段写入 startup_timeout_ms", () => {
  const input = [
    "[mcp_servers.chrome-devtools]",
    'command = "cmd"',
    'args = ["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--isolated=true", "--channel=stable"]',
    'env = { SystemRoot="C:\\\\Windows", PROGRAMFILES="C:\\\\Program Files" }',
    "",
    "[mcp_servers.fetch]",
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-fetch"]',
    "",
  ].join("\n");

  const output = updateCodexMcpServerConfigText(input, "chrome-devtools", { startupTimeoutMs: 20_000 });

  assert.match(output, /\[mcp_servers\.chrome-devtools\][\s\S]*startup_timeout_ms = 20_000/);
  assert.match(output, /\[mcp_servers\.fetch\][\s\S]*command = "npx"/);
});

test("MCP 互斥守卫应拒绝并发变更操作", async () => {
  const guard = createMcpMutationGuard();
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = guard.runExclusive({ npmPackage: "chrome-devtools-mcp", kind: "install" }, async () => {
    await firstDone;
    return "done";
  });

  const second = await guard.runExclusive({ npmPackage: "@jshookmcp/jshook", kind: "configure", engine: "codex" }, async () => "should-not-run");

  if (second.ok) {
    assert.fail("并发操作应被守卫拒绝");
  }
  assert.match(second.error, /chrome-devtools-mcp/);
  assert.match(second.error, /安装/);

  releaseFirst();
  const firstResult = await first;
  assert.deepEqual(firstResult, { ok: true, value: "done" });

  const third = await guard.runExclusive({ npmPackage: "@jshookmcp/jshook", kind: "configure", engine: "codex" }, async () => "ok");
  assert.deepEqual(third, { ok: true, value: "ok" });
});
