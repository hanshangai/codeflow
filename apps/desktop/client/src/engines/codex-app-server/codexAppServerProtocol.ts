import { type AccessMode, type CodexServiceTier, type ExecutableToolRegistry } from "@codeflowai/shared";

export type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
};

const CODEX_DYNAMIC_TOOL_NAME_FALLBACK = "aidt_tool";

/**
 * Codex 的动态工具最终会被注入到 Responses API 的 `tools` 字段里。
 * 这里仅做最弱的本地预判：
 * - 只要 baseUrl 形态像一个可访问的 OpenAI 兼容入口，就允许真实发起 dynamic tools 请求；
 * - 是否真的被上游接受，以运行时返回结果为准，不在这里先验判死。
 */
export function supportsCodexNativeDynamicToolTransport(baseUrl?: string | null): boolean {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return true;

  try {
    const url = new URL(raw);
    return Boolean(url.protocol && url.hostname);
  } catch {
    return false;
  }
}

/**
 * 将 accessMode 映射为 Codex app-server 的 approvalPolicy。
 * - `read-only` 已经由只读 sandbox 保证不能写文件，因此编排线程里的纯读原生工具不应再等待人工审批。
 * - `current` 仍保留 on-request，因为它允许在工作区写文件且通常伴随网络访问。
 */
export function resolveApprovalPolicy(accessMode: AccessMode): "never" | "on-request" {
  return accessMode === "current" ? "on-request" : "never";
}

function normalizeContextWindow(contextWindow?: number | null): number | null {
  const normalized = Number(contextWindow ?? 0);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.round(normalized);
}

function normalizeAutoCompactPct(autoCompactPct?: number | null): number | null {
  const normalized = Number(autoCompactPct ?? 0);
  if (!Number.isFinite(normalized) || normalized < 50 || normalized > 99) return null;
  return Math.round(normalized);
}

export type CodexThreadConfigOverrides = {
  modelContextWindow: number | null;
  modelAutoCompactTokenLimit: number | null;
};

/** 将 Client 运行时配置映射为 Codex app-server 的 provider 名称。 */
export function resolveCodexAppServerModelProvider(
  runtimeConfig: { baseUrl?: string | null } | null | undefined,
): string | null {
  if (!runtimeConfig) return null;
  return String(runtimeConfig.baseUrl ?? "").trim() ? "codeflowai" : "openai";
}

/** Keeps thread resume responses bounded; callers read required history through paginated RPCs. */
export function excludeTurnsFromThreadResume(method: string, params: unknown): unknown {
  if (method !== "thread/resume" || !params || typeof params !== "object" || Array.isArray(params)) return params;
  return { ...(params as Record<string, unknown>), excludeTurns: true };
}

export function resolveCodexThreadConfigOverrides(opts: {
  contextWindow?: number | null;
  autoCompactPct?: number | null;
}): CodexThreadConfigOverrides {
  const modelContextWindow = normalizeContextWindow(opts.contextWindow);
  const autoCompactPct = normalizeAutoCompactPct(opts.autoCompactPct);
  if (modelContextWindow == null || autoCompactPct == null) {
    return { modelContextWindow, modelAutoCompactTokenLimit: null };
  }

  return {
    modelContextWindow,
    modelAutoCompactTokenLimit: Math.round(modelContextWindow * autoCompactPct / 100),
  };
}

/** 新建线程时开启普通模式提问，并保留本轮模型及上下文配置。 */
export function buildThreadStartRequestParams(opts: {
  cwd: string;
  accessMode: AccessMode;
  contextWindow?: number | null;
  autoCompactPct?: number | null;
  modelProvider?: string | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  developerInstructions?: string | null;
}): Record<string, unknown> {
  const configOverrides = resolveCodexThreadConfigOverrides(opts);
  const config: Record<string, unknown> = { "features.default_mode_request_user_input": true };
  if (configOverrides.modelContextWindow != null) {
    config.model_context_window = configOverrides.modelContextWindow;
  }
  if (configOverrides.modelAutoCompactTokenLimit != null) {
    config.model_auto_compact_token_limit = configOverrides.modelAutoCompactTokenLimit;
  }
  return {
    cwd: opts.cwd,
    approvalPolicy: resolveApprovalPolicy(opts.accessMode),
    ...(String(opts.modelProvider ?? "").trim() ? { modelProvider: String(opts.modelProvider).trim() } : {}),
    config,
    ...(opts.dynamicTools?.length ? { dynamicTools: opts.dynamicTools } : {}),
    ...(opts.developerInstructions !== undefined
      ? { developerInstructions: opts.developerInstructions }
      : {}),
  };
}

/** 恢复时同样开启普通模式提问；历史由分页读取入口加载。 */
export function buildThreadResumeRequestParams(opts: {
  threadId: string;
  cwd: string;
  accessMode: AccessMode;
  contextWindow?: number | null;
  autoCompactPct?: number | null;
  modelProvider?: string | null;
  developerInstructions?: string | null;
}): Record<string, unknown> {
  const configOverrides = resolveCodexThreadConfigOverrides(opts);
  const config: Record<string, unknown> = { "features.default_mode_request_user_input": true };
  if (configOverrides.modelContextWindow != null) {
    config.model_context_window = configOverrides.modelContextWindow;
  }
  if (configOverrides.modelAutoCompactTokenLimit != null) {
    config.model_auto_compact_token_limit = configOverrides.modelAutoCompactTokenLimit;
  }
  return {
    threadId: opts.threadId,
    excludeTurns: true,
    cwd: opts.cwd,
    approvalPolicy: resolveApprovalPolicy(opts.accessMode),
    ...(String(opts.modelProvider ?? "").trim() ? { modelProvider: String(opts.modelProvider).trim() } : {}),
    config,
    ...(opts.developerInstructions !== undefined
      ? { developerInstructions: opts.developerInstructions }
      : {}),
  };
}

/** 构造 `turn/start` 参数（对齐 CodeMoss 的 sandbox/approval 思路）。 */
export function buildTurnStartParams(opts: {
  threadId: string;
  cwd: string;
  text: string;
  images: string[];
  skillInputs?: ReadonlyArray<{ name: string; path: string }>;
  accessMode: AccessMode;
  model?: string | null;
  effort?: string | null;
  /** Codex app-server 服务档位；null 必须显式发送以清空 Fast。 */
  serviceTier?: CodexServiceTier | null;
  /** 可选：协作模式（输入侧的 Plan 模式开关）：`plan | default`。与 todolist(update_plan) 工具产物解耦。 */
  collaborationMode?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const input = buildCodexUserInput({
    text: opts.text,
    images: opts.images,
    skillInputs: opts.skillInputs,
  });

  const sandboxPolicy =
    opts.accessMode === "full-access"
      ? { type: "dangerFullAccess" }
      : opts.accessMode === "read-only"
        ? { type: "readOnly" }
        : { type: "workspaceWrite", writableRoots: [opts.cwd], networkAccess: true };

  return {
    threadId: opts.threadId,
    input,
    cwd: opts.cwd,
    approvalPolicy: resolveApprovalPolicy(opts.accessMode),
    sandboxPolicy,
    ...(opts.model != null ? { model: opts.model } : {}),
    ...(opts.effort != null ? { effort: opts.effort } : {}),
    serviceTier: opts.serviceTier ?? null,
    ...(opts.collaborationMode ? { collaborationMode: opts.collaborationMode } : {}),
  };
}

/** 构造 `turn/steer` 参数，用于 active turn 内追加用户输入。 */
export function buildTurnSteerParams(opts: {
  threadId: string;
  expectedTurnId: string;
  text: string;
  images: string[];
}): Record<string, unknown> {
  return {
    threadId: opts.threadId,
    expectedTurnId: opts.expectedTurnId,
    input: buildCodexUserInput({ text: opts.text, images: opts.images }),
  };
}

/** 将 Web 文本/图片输入映射为 Codex app-server UserInput。 */
function buildCodexUserInput(opts: {
  text: string;
  images: string[];
  skillInputs?: ReadonlyArray<{ name: string; path: string }>;
}): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  const t = opts.text.trim();
  if (t) input.push({ type: "text", text: t });
  for (const img of opts.images) {
    const s = String(img ?? "").trim();
    if (!s) continue;
    if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) input.push({ type: "image", url: s });
    else input.push({ type: "localImage", path: s });
  }
  for (const skill of opts.skillInputs ?? []) {
    input.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return input;
}

/** 从 JSON-RPC result 中提取 threadId（适配不同返回形态）。 */
export function extractThreadIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as any;
  const thread = r.thread ?? r.result?.thread ?? r;
  const id = String(thread?.id ?? r.threadId ?? r.thread_id ?? "").trim();
  return id || null;
}

/** 从 JSON-RPC result 中提取 turnId（适配不同返回形态）。 */
export function extractTurnIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as any;
  const turn = r.turn ?? r.result?.turn ?? r;
  const id = String(turn?.id ?? r.turnId ?? r.turn_id ?? "").trim();
  return id || null;
}

export function buildCodexDynamicToolSpecs(toolRegistry: ExecutableToolRegistry | null | undefined): CodexDynamicToolSpec[] {
  if (!toolRegistry?.tools.length) return [];
  const toolNameByToolId = buildCodexDynamicToolNameByToolId(toolRegistry);
  return toolRegistry.tools.map((tool) => ({
    name: toolNameByToolId.get(String(tool.toolId ?? "").trim()) ?? CODEX_DYNAMIC_TOOL_NAME_FALLBACK,
    description: buildCodexDynamicToolDescription(tool),
    inputSchema: parseToolSchema(tool.inputSchema),
  }));
}

export function buildCodexDynamicToolNameByToolId(
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
    if (!toolId) continue;
    const baseName = sanitizeCodexDynamicToolName(toolId);
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

export function buildCodexDynamicToolToolIdByName(
  toolRegistry: ExecutableToolRegistry | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  const toolNameByToolId = buildCodexDynamicToolNameByToolId(toolRegistry);
  for (const [toolId, toolName] of toolNameByToolId.entries()) {
    result.set(toolName, toolId);
  }
  return result;
}

export function buildCodexDynamicToolBindingVersion(
  toolRegistry: ExecutableToolRegistry | null | undefined,
): string | null {
  if (!toolRegistry?.tools.length) return null;
  const toolNameByToolId = buildCodexDynamicToolNameByToolId(toolRegistry);
  const entries = toolRegistry.tools
    .map((tool) => {
      const toolId = String(tool.toolId ?? "").trim();
      const wireName = toolNameByToolId.get(toolId) ?? CODEX_DYNAMIC_TOOL_NAME_FALLBACK;
      return toolId ? `${toolId}=>${wireName}` : null;
    })
    .filter((item): item is string => Boolean(item))
    .sort();
  return entries.length ? entries.join("|") : null;
}

export function listExecutableToolIds(toolRegistry: ExecutableToolRegistry | null | undefined): string[] {
  if (!toolRegistry?.tools.length) return [];
  return Array.from(
    new Set(
      toolRegistry.tools
        .map((tool) => String(tool.toolId ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

function buildCodexDynamicToolDescription(tool: ExecutableToolRegistry["tools"][number]): string {
  const lines = [
    `名称：${tool.alias || tool.name}`,
    `说明：${tool.description}`,
  ];
  const usageGuidance = String(tool.usageGuidance ?? "").trim();
  if (usageGuidance) lines.push(`使用边界：${usageGuidance}`);
  const invocationHint = String(tool.invocationHint ?? "").trim();
  if (invocationHint) lines.push(`调用提示：${invocationHint}`);
  return lines.join("\n");
}

function sanitizeCodexDynamicToolName(toolId: string): string {
  const normalized = String(toolId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withPrefix = normalized ? `aidt_${normalized}` : CODEX_DYNAMIC_TOOL_NAME_FALLBACK;
  if (withPrefix === "mcp" || withPrefix.startsWith("mcp__")) {
    return `${CODEX_DYNAMIC_TOOL_NAME_FALLBACK}_${withPrefix}`;
  }
  return withPrefix;
}

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
  } catch {
    return {
      type: "object",
      additionalProperties: true,
    };
  }
}

