import path from "node:path";

import type { TerminalAction } from "@codeflowai/shared";
import { logger } from "../logger.js";

import {
  cleanupLegacyWorkspaceCodeflowaiDirectory,
  ensureWorkspaceCodeflowaiDirectory,
  inspectExistingWorkspaceCodeflowaiDirectory,
  inspectWorkspaceCodeflowaiFile,
  LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY,
  readWorkspaceCodeflowaiFile,
  writeWorkspaceCodeflowaiFile,
} from "../codeflowai/workspaceCodeflowaiDirectory.js";

const TERMINAL_ACTIONS_FILE = "terminal-actions.json";

/** terminal-actions.json 路径：`<workspace>/.codeflowai/terminal-actions.json`。 */
export function terminalActionsPath(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), ".codeflowai", TERMINAL_ACTIONS_FILE);
}

/** 读取终端自定义操作配置；新目录优先，历史 `codeflowai/` 回退读取。 */
export function readTerminalActions(workspacePath: string): TerminalAction[] {
  const current = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath);
  const legacy = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath, LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY);
  const directory = current && inspectWorkspaceCodeflowaiFile(current, TERMINAL_ACTIONS_FILE) ? current
    : legacy && inspectWorkspaceCodeflowaiFile(legacy, TERMINAL_ACTIONS_FILE) ? legacy : null;
  if (!directory) return [];
  try {
    const parsed = JSON.parse(readWorkspaceCodeflowaiFile(directory, TERMINAL_ACTIONS_FILE).toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeAction).sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

/** 写入终端自定义操作配置到新控制目录。 */
export function writeTerminalActions(workspacePath: string, actions: TerminalAction[]): TerminalAction[] {
  const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
  const normalized = actions.map(normalizeAction).sort((a, b) => a.order - b.order);
  writeWorkspaceCodeflowaiFile(directory, TERMINAL_ACTIONS_FILE, JSON.stringify(normalized, null, 2));
  cleanupLegacyWorkspaceCodeflowaiDirectory(workspacePath, error => logger.warn("terminal-config", "legacy control directory cleanup deferred", {
    code: "workspace_legacy_control_directory_cleanup_deferred",
    workspacePath,
    rootCause: (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
  }));
  return normalized;
}

function normalizeAction(raw: unknown): TerminalAction {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: String(obj.id ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    label: String(obj.label ?? "").trim() || "Untitled",
    command: String(obj.command ?? "").trim(),
    shell: obj.shell != null ? String(obj.shell).trim() || null : null,
    cwd: obj.cwd != null ? String(obj.cwd).trim() || null : null,
    icon: obj.icon != null ? String(obj.icon).trim() || null : null,
    color: obj.color != null ? String(obj.color).trim() || null : null,
    order: typeof obj.order === "number" ? obj.order : 0,
    autoRun: obj.autoRun === true,
    enabled: obj.enabled !== false,
  };
}
