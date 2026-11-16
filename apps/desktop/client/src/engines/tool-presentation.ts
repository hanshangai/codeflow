import { formatPathListSummary } from "@codeflowai/shared";

import { extractToolChanges, type ToolChangePresentation } from "./toolFilePaths.js";

export type { ToolChangePresentation } from "./toolFilePaths.js";

export type ToolPresentation = {
  summary?: string;
  changes?: ToolChangePresentation[];
};

export function createToolPresentation(opts: {
  toolName: string;
  input?: unknown;
  workspacePath?: string | null;
}): ToolPresentation {
  const toolKey = normalizeToolNameKey(opts.toolName);
  const changes = extractToolChanges({
    engine: inferEngine(toolKey),
    toolName: opts.toolName,
    input: opts.input,
    workspacePath: opts.workspacePath ?? null,
    mode: "display",
  });

  const summary = changes.length
    ? formatPathListSummary(changes.map((change) => change.path), { preferBaseName: isFilePathSummaryTool(toolKey) })
    : deriveNonPathSummary(toolKey, opts.input);

  return { changes: changes.length ? changes : undefined, summary: summary || undefined };
}

function inferEngine(toolKey: string): "claude" | "codex" {
  return toolKey === "filechange" || toolKey === "file_change" || toolKey === "collabagenttoolcall" ? "codex" : "claude";
}

function normalizeToolNameKey(toolNameRaw: string): string {
  return String(toolNameRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isFilePathSummaryTool(toolKey: string): boolean {
  return toolKey === "read" || toolKey === "read_file" || toolKey === "readfile" || isMutationTool(toolKey);
}

function isMutationTool(toolKey: string): boolean {
  return (
    toolKey === "filechange" ||
    toolKey === "file_change" ||
    toolKey === "edit" ||
    toolKey === "multi_edit" ||
    toolKey === "multiedit" ||
    toolKey === "write" ||
    toolKey === "write_file" ||
    toolKey === "writefile" ||
    toolKey === "delete"
  );
}

function deriveNonPathSummary(toolKey: string, input: unknown): string {
  if (toolKey === "contextcompaction" || toolKey === "context_compaction") {
    return "上下文压缩";
  }

  if (isCommandLikeTool(toolKey)) {
    const command = pickFirstNonEmptyString(input, ["command", "cmd"]);
    if (command) return command;
  }

  // Agent（Claude）与 Task 工具 input 同形：description + subagent_type，均可能缺省。
  if (toolKey === "task" || toolKey === "agent") {
    const description = pickFirstNonEmptyString(input, ["description"]);
    const agentType = pickFirstNonEmptyString(input, ["subagent_type"]);
    if (description && agentType) return `[${agentType}] ${description}`;
    if (description) return description;
    if (agentType) return `subagent: ${agentType}`;
    const prompt = pickFirstNonEmptyString(input, ["prompt"]);
    if (prompt) return `启动 agent: ${abbreviate(prompt, 80)}`;
  }

  if (toolKey === "collabagenttoolcall") {
    const tool = pickFirstNonEmptyString(input, ["tool"]);
    const prompt = pickFirstNonEmptyString(input, ["prompt"]);
    if (tool === "spawnAgent" && prompt) return `启动 agent: ${abbreviate(prompt, 80)}`;
    if (tool === "spawnAgent") return "启动 agent";
    if (tool === "sendInput") return `发送输入: ${abbreviate(prompt || pickFirstNonEmptyString(input, ["input"]), 80)}`;
    if (tool === "wait") return "等待 agent";
    if (tool === "closeAgent") return "关闭 agent";
    if (tool) return `agent: ${tool}`;
  }

  return "";
}

function isCommandLikeTool(toolKey: string): boolean {
  return toolKey === "commandexecution" || toolKey === "command_execution" || toolKey === "bash" || toolKey === "run";
}

function pickFirstNonEmptyString(input: unknown, keys: string[]): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function abbreviate(text: string, maxLen: number): string {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

