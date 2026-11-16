/**
 * 写工作区文件的工具名（与 Client 侧文件变更判定同一口径）。
 * chat.ts 的文件变更计数直接复用这份名单，避免出现第二份清单。
 */
const FILE_MUTATION_TOOL_KEYS = new Set([
  "edit",
  "multi_edit",
  "multiedit",
  "write",
  "write_file",
  "writefile",
  "delete",
  // Codex
  "filechange",
  "file_change",
]);

/** 只在 Git 刷新口径里需要、但不计入文件变更计数的写工具。 */
const EXTRA_MUTATION_TOOL_KEYS = new Set(["notebookedit", "notebook_edit"]);

/** 命令执行类工具名关键字（Claude 的 Bash、Codex 的 commandExecution 等）。 */
const COMMAND_TOOL_HINTS = ["bash", "shell", "command", "exec"];

/** 名称命中了写/命令关键字、但实际不改工作区的工具，必须先排除（如待办更新）。 */
const NON_MUTATING_TOOL_KEYS = new Set(["todowrite", "todo_write", "update_plan", "updateplan"]);

/** 归一化工具名：小写并把空白、连字符统一为下划线。 */
function normalizeToolName(toolName: unknown): string {
  if (!toolName || typeof toolName !== "string") return "";
  return toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** 判断工具是否写工作区文件；与 chat.ts 的文件变更计数共用同一份名单。 */
export function isFileMutationToolName(toolName: unknown): boolean {
  return FILE_MUTATION_TOOL_KEYS.has(normalizeToolName(toolName));
}

/** 判断一次工具调用是否可能改动工作区（写文件或执行命令）。 */
export function isWorkspaceMutatingToolName(toolName: string | null | undefined): boolean {
  const key = normalizeToolName(toolName);
  if (!key || NON_MUTATING_TOOL_KEYS.has(key)) return false;
  if (FILE_MUTATION_TOOL_KEYS.has(key) || EXTRA_MUTATION_TOOL_KEYS.has(key)) return true;
  return COMMAND_TOOL_HINTS.some((hint) => key.includes(hint));
}
