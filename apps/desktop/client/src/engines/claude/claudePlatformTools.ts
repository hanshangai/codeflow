import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccessMode, ExecutableToolRegistry } from "@codeflowai/shared";

import { clearPlatformToolFailureCounts, platformToolFailureKey, type HostToolExecutionResult, type HostToolExecutor } from "../threadSession.js";

export const CLAUDE_PLATFORM_MCP_SERVER_NAME = "aidt_runtime";

type ClaudePlatformToolSpec = {
  toolId: string;
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ClaudePlatformToolBridge = {
  mcpConfigPath: string;
  toolNames: string[];
  isPlatformToolName: (name: string) => boolean;
  /** 更新长驻 Claude session 当前回合使用的 host tool 执行上下文。 */
  updateExecutionContext: (input: {
    executeHostTool: HostToolExecutor;
    accessMode: AccessMode;
    onFatalError: (error: Error) => void;
  }) => void;
  dispose: () => Promise<void>;
};

type BridgeRequestBody = {
  name?: unknown;
  arguments?: unknown;
};

const CLAUDE_PLATFORM_TOOL_NAME_FALLBACK = "aidt_tool";
const MAX_BRIDGE_BODY_BYTES = 10 * 1024 * 1024;
const PLATFORM_TOOL_FAILURE_RETRY_LIMIT = 5;

/**
 * 将平台工具注册表转成 Claude MCP 可暴露的工具定义。
 */
export function buildClaudePlatformToolSpecs(
  toolRegistry: ExecutableToolRegistry | null | undefined,
): ClaudePlatformToolSpec[] {
  if (!toolRegistry?.tools.length) return [];
  const toolNameByToolId = buildClaudePlatformToolNameByToolId(toolRegistry);
  return toolRegistry.tools.map((tool) => {
    const toolId = String(tool.toolId ?? "").trim();
    return {
      toolId,
      name: toolNameByToolId.get(toolId) ?? CLAUDE_PLATFORM_TOOL_NAME_FALLBACK,
      description: buildClaudePlatformToolDescription(tool),
      inputSchema: parseToolSchema(tool.inputSchema),
    };
  });
}

/**
 * 为 Claude MCP 生成稳定且 provider-safe 的工具名映射。
 */
export function buildClaudePlatformToolNameByToolId(
  toolRegistry: ExecutableToolRegistry | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!toolRegistry?.tools.length) return result;

  const usedNames = new Set<string>();
  const toolIds = Array.from(
    new Set(
      toolRegistry.tools
        .map((tool) => String(tool.toolId ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();

  for (const toolId of toolIds) {
    const baseName = sanitizeClaudePlatformToolName(toolId);
    let candidate = baseName;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(candidate);
    result.set(toolId, candidate);
  }
  return result;
}

/**
 * 启动本 turn 专用 bridge；MCP 使用当前可执行文件时显式保留 Electron Node 模式。
 */
export async function createClaudePlatformToolBridge(opts: {
  toolRegistry: ExecutableToolRegistry | null | undefined;
  executeHostTool: HostToolExecutor | null | undefined;
  accessMode: AccessMode;
  onFatalError: (error: Error) => void;
}): Promise<ClaudePlatformToolBridge | null> {
  const toolSpecs = buildClaudePlatformToolSpecs(opts.toolRegistry);
  if (!toolSpecs.length) return null;
  if (!opts.executeHostTool) {
    throw new Error("Claude 平台工具 bridge 缺少 executeHostTool，无法注册真实平台工具。");
  }

  const scriptPath = resolveClaudePlatformToolMcpServerScriptPath();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codeflowai-claude-platform-tools-"));
  const registryPath = path.join(tmpDir, "registry.json");
  const configPath = path.join(tmpDir, "mcp.json");
  const token = crypto.randomBytes(24).toString("hex");
  const bridge = new PlatformToolHttpBridge({
    toolSpecs,
    executeHostTool: opts.executeHostTool,
    accessMode: opts.accessMode,
    token,
    onFatalError: opts.onFatalError,
  });

  try {
    const bridgeUrl = await bridge.listen();
    await fsp.writeFile(registryPath, JSON.stringify({ tools: toolSpecs }, null, 2), "utf8");
    await fsp.writeFile(configPath, JSON.stringify({
      mcpServers: {
        [CLAUDE_PLATFORM_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [scriptPath],
          env: {
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            CODEFLOWAI_PLATFORM_TOOLS_REGISTRY_PATH: registryPath,
            CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL: bridgeUrl,
            CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN: token,
          },
        },
      },
    }, null, 2), "utf8");
  } catch (error) {
    const cleanupErrors: string[] = [];
    try {
      await bridge.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    if (cleanupErrors.length && error instanceof Error) {
      (error as Error & { cleanupErrors?: string[] }).cleanupErrors = cleanupErrors;
    }
    throw error;
  }

  const toolNames = toolSpecs.map((tool) => tool.name);
  return {
    mcpConfigPath: configPath,
    toolNames,
    isPlatformToolName: (name: string) => isClaudePlatformToolName(name, toolNames),
    updateExecutionContext: (input) => {
      bridge.updateExecutionContext(input);
    },
    dispose: async () => {
      await bridge.close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * 判断 Claude control_request 中的工具名是否属于本轮平台工具。
 */
export function isClaudePlatformToolName(name: string, toolNames: Iterable<string>): boolean {
  const normalized = normalizeToolName(name);
  if (!normalized) return false;
  for (const toolName of toolNames) {
    const safeName = normalizeToolName(toolName);
    if (!safeName) continue;
    if (normalized === safeName) return true;
    if (normalized === normalizeToolName(`mcp__${CLAUDE_PLATFORM_MCP_SERVER_NAME}__${safeName}`)) return true;
  }
  return false;
}

class PlatformToolHttpBridge {
  private server: http.Server | null = null;
  private readonly toolIdByName: Map<string, string>;
  private readonly failureCounts = new Map<string, number>();
  private fatal = false;

  constructor(
    private readonly opts: {
      toolSpecs: ClaudePlatformToolSpec[];
      executeHostTool: HostToolExecutor;
      accessMode: AccessMode;
      token: string;
      onFatalError: (error: Error) => void;
    },
  ) {
    this.toolIdByName = new Map(opts.toolSpecs.map((tool) => [tool.name, tool.toolId]));
  }

  /**
   * 长驻 Claude 进程跨 turn 复用 MCP server 时，替换本轮 host tool 闭包。
   * 工具定义本身由 session 配置指纹保证不变；执行上下文允许随 turn 更新。
   */
  updateExecutionContext(input: {
    executeHostTool: HostToolExecutor;
    accessMode: AccessMode;
    onFatalError: (error: Error) => void;
  }): void {
    this.opts.executeHostTool = input.executeHostTool;
    this.opts.accessMode = input.accessMode;
    this.opts.onFatalError = input.onFatalError;
  }

  /**
   * 监听本地随机端口，供本轮 MCP server 回调平台工具。
   */
  listen(): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Claude 平台工具 bridge 未能绑定本地端口。"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(0, "127.0.0.1");
    });
  }

  /**
   * 关闭本地 bridge，释放本轮临时端口。
   */
  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/call") {
      writeJson(res, 404, { ok: false, message: "not found", code: "NOT_FOUND" });
      return;
    }
    const auth = String(req.headers.authorization ?? "").trim();
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : String(req.headers["x-codeflowai-token"] ?? "").trim();
    if (token !== this.opts.token) {
      writeJson(res, 401, { ok: false, message: "unauthorized", code: "UNAUTHORIZED" });
      return;
    }

    let body: BridgeRequestBody;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        code: "BAD_REQUEST",
      });
      return;
    }

    const result = await this.callTool(body);
    writeJson(res, 200, result);
  }

  private async callTool(body: BridgeRequestBody): Promise<HostToolExecutionResult> {
    const toolName = String(body.name ?? "").trim();
    const toolId = this.toolIdByName.get(toolName) ?? "";
    if (!toolId) {
      return {
        ok: false,
        message: `当前回合未注册 Claude 平台工具：${toolName || "<empty>"}`,
        code: "TOOL_NOT_FOUND",
      };
    }

    try {
      const result = await this.opts.executeHostTool({
        toolId,
        toolInput: body.arguments,
        accessMode: this.opts.accessMode,
      });
      if (result.ok) {
        clearPlatformToolFailureCounts(this.failureCounts, toolId);
      } else {
        this.recordFailure(toolId, body.arguments, result);
      }
      return result;
    } catch (error) {
      const result: HostToolExecutionResult = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        code: "TOOL_EXECUTION_FAILED",
      };
      this.recordFailure(toolId, body.arguments, result);
      return result;
    }
  }

  /** 记录平台工具失败；知识读取上限直接终止当前 turn，不进入通用重试。 */
  private recordFailure(
    toolId: string,
    toolInput: unknown,
    result: Extract<HostToolExecutionResult, { ok: false }>,
  ): void {
    const displayName = this.opts.toolSpecs.find((tool) => tool.toolId === toolId)?.name ?? toolId;
    if (result.code === "KNOWLEDGE_ASSET_READ_LIMIT_REACHED") {
      if (this.fatal) return;
      this.fatal = true;
      this.opts.onFatalError(createPlatformToolReadLimitError(displayName, result.message));
      return;
    }
    const failureKey = platformToolFailureKey(toolId, toolInput, result);
    const failureCount = (this.failureCounts.get(failureKey) ?? 0) + 1;
    this.failureCounts.set(failureKey, failureCount);
    if (failureCount < PLATFORM_TOOL_FAILURE_RETRY_LIMIT || this.fatal) return;
    this.failureCounts.delete(failureKey);
    this.fatal = true;
    this.opts.onFatalError(createPlatformToolRetryExhaustedError(
      displayName,
      failureCount,
      result.message,
      result.code ?? null,
    ));
  }
}

/** 把知识读取上限转换为可追踪的终止错误，避免平台继续重试同一调用。 */
function createPlatformToolReadLimitError(toolName: string, failureMessage: string): Error & { code: "platform_tool_read_limit_reached"; toolFailureCode?: string | null } {
  const error = new Error(`平台工具 ${toolName} 已达到本轮读取上限：${failureMessage || "请整理已有证据后提交当前资产"}`) as Error & { code: "platform_tool_read_limit_reached"; toolFailureCode?: string | null };
  error.code = "platform_tool_read_limit_reached";
  error.toolFailureCode = "KNOWLEDGE_ASSET_READ_LIMIT_REACHED";
  return error;
}

function createPlatformToolRetryExhaustedError(
  toolName: string,
  failureCount: number,
  failureMessage: string,
  failureCode: string | null,
): Error & { code: "platform_tool_failed_too_many_times"; toolFailureCode?: string | null } {
  const error = new Error(
    `平台工具 ${toolName} 在同一轮内已连续失败 ${failureCount} 次：${failureMessage || "执行失败"}`,
  ) as Error & { code: "platform_tool_failed_too_many_times"; toolFailureCode?: string | null };
  error.code = "platform_tool_failed_too_many_times";
  error.toolFailureCode = failureCode;
  return error;
}

function resolveClaudePlatformToolMcpServerScriptPath(): string {
  const fromEnv = String(process.env.CODEFLOWAI_CLAUDE_PLATFORM_TOOLS_MCP_SERVER ?? "").trim();
  if (fromEnv) return path.resolve(fromEnv);

  const candidates = [
    path.resolve(process.cwd(), "apps/desktop/client/scripts/claude-platform-tools-mcp.cjs"),
    path.resolve(process.cwd(), "scripts/claude-platform-tools-mcp.cjs"),
    ...resolveRuntimeBaseDirs().flatMap((baseDir) => [
      path.resolve(baseDir, "../scripts/claude-platform-tools-mcp.cjs"),
      path.resolve(baseDir, "scripts/claude-platform-tools-mcp.cjs"),
    ]),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`未找到 Claude 平台工具 MCP server 脚本：${candidates.join("; ")}`);
}

function resolveRuntimeBaseDirs(): string[] {
  const dirs = new Set<string>();
  const argvFile = String(process.argv[1] ?? "").trim();
  if (argvFile) dirs.add(path.dirname(path.resolve(argvFile)));
  if (typeof __filename === "string" && __filename) {
    dirs.add(path.dirname(__filename));
  }
  return Array.from(dirs);
}

function buildClaudePlatformToolDescription(tool: ExecutableToolRegistry["tools"][number]): string {
  const lines = [
    `平台工具ID：${tool.toolId}`,
    `名称：${tool.alias || tool.name}`,
    `说明：${tool.description}`,
  ];
  const usageGuidance = String(tool.usageGuidance ?? "").trim();
  if (usageGuidance) lines.push(`使用边界：${usageGuidance}`);
  const invocationHint = String(tool.invocationHint ?? "").trim();
  if (invocationHint) lines.push(`调用提示：${invocationHint}`);
  return lines.join("\n");
}

function sanitizeClaudePlatformToolName(toolId: string): string {
  const normalized = String(toolId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withPrefix = normalized ? `aidt_${normalized}` : CLAUDE_PLATFORM_TOOL_NAME_FALLBACK;
  if (withPrefix === "mcp" || withPrefix.startsWith("mcp__")) {
    return `${CLAUDE_PLATFORM_TOOL_NAME_FALLBACK}_${withPrefix}`;
  }
  return withPrefix;
}

/** 解析平台工具 schema；无 schema 时给默认 object，非法 JSON 则显式失败。 */
function parseToolSchema(raw: string | null | undefined): unknown {
  const text = String(raw ?? "").trim();
  if (!text) {
    return {
      type: "object",
      additionalProperties: true,
    };
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Claude 平台工具 inputSchema 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeToolName(name: string): string {
  return String(name ?? "").trim();
}

function readJsonBody(req: http.IncomingMessage): Promise<BridgeRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BRIDGE_BODY_BYTES) {
        reject(new Error("Claude 平台工具 bridge 请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, body: HostToolExecutionResult | Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
