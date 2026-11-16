import type {
  ConversationExplore,
  ConversationItem,
  ConversationReview,
  ConversationTool,
  RequirementAnalysisAssistantPayload,
} from "../index.js";

type ExploreEntry = ConversationExplore["entries"][number];

export type RequirementAnalysisDisplayItem = {
  kind: "requirementAnalysis";
  id: string;
  sourceMessageId: string;
  rawText: string;
  payload: RequirementAnalysisAssistantPayload;
};

export type DisplayConversationItem =
  | ConversationItem
  | RequirementAnalysisDisplayItem;

const READ_COMMANDS = new Set(["cat", "sed", "head", "tail", "less", "more", "nl", "type"]);
const LIST_COMMANDS = new Set(["ls", "dir", "tree", "find", "fd"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "ripgrep", "findstr"]);

/**
 * 将底层 items 转为“更适合聊天区展示”的 items。
 * - 参考 CodeMoss：把高频 tool（commandExecution/bash/...）归并为 explore 卡片，减少噪音
 * - 不修改原 items：只返回 displayItems（Inspector 仍可查看原 tool 列表）
 */
export function prepareConversationItemsForDisplay(items: ConversationItem[]): DisplayConversationItem[] {
  const out: DisplayConversationItem[] = [];
  let mergedExplore: ConversationExplore | null = null;
  const exploreEntryKeys = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const protocolItem = summarizeProtocolMessage(item);
    if (protocolItem) {
      out.push(protocolItem);
      continue;
    }

    if (item.kind !== "tool") {
      out.push(item);
      continue;
    }

    const projectedDisplay = (item as ConversationTool & { _display?: ConversationExplore | ConversationReview })._display;
    const review = projectedDisplay?.kind === "review" ? { ...projectedDisplay } : summarizeToolAsReview(item);
    if (review) {
      out.push(review);
      continue;
    }

    const explore = projectedDisplay?.kind === "explore" ? { ...projectedDisplay, entries: [...projectedDisplay.entries] } : summarizeToolAsExplore(item);
    if (!explore) {
      out.push(item);
      continue;
    }

    const last = out.length ? out[out.length - 1] : null;
    if (last?.kind === "explore" && last.status === explore.status) {
      if (last !== mergedExplore) {
        mergedExplore = { ...last, entries: [] };
        exploreEntryKeys.clear();
        mergeExploreEntries(mergedExplore.entries, last.entries, exploreEntryKeys);
        out[out.length - 1] = mergedExplore;
      }
      mergeExploreEntries(mergedExplore.entries, explore.entries, exploreEntryKeys);
      continue;
    }
    out.push(explore);
  }
  return out;
}

function summarizeProtocolMessage(item: ConversationItem): DisplayConversationItem | null {
  if (item.kind !== "message") return null;
  if (item.role !== "assistant") return null;
  const payload = normalizeRequirementAnalysisPayload(item.structuredPayloadJson ?? item.text);
  if (!payload) return null;
  return {
    kind: "requirementAnalysis",
    id: `requirement_analysis_${String(item.id)}`,
    sourceMessageId: String(item.id),
    rawText: item.structuredPayloadJson ?? item.text,
    payload,
  };
}

function normalizeRequirementAnalysisPayload(text: string): RequirementAnalysisAssistantPayload | null {
  const { payload } = tryParseProtocolPayload(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const schemaVersion = (payload as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== "requirement-analysis-assistant/v1" && schemaVersion !== "requirement-analysis-assistant/v2") return null;
  return payload as RequirementAnalysisAssistantPayload;
}


/** 将 tool 归并为 review 卡片（目前仅支持 Codex entered/exitedReviewMode）。 */
function summarizeToolAsReview(tool: ConversationTool): ConversationReview | null {
  if (tool.toolType !== "enteredReviewMode" && tool.toolType !== "exitedReviewMode") return null;
  const state: ConversationReview["state"] = tool.toolType === "enteredReviewMode" ? "started" : "completed";
  const text = extractReviewText(tool) || tool.toolType;
  return { kind: "review", id: `review_${tool.id}` as any, state, text };
}

/** 将 tool 归并为 explore 卡片（commandExecution/bash/read/search/list 等）。 */
function summarizeToolAsExplore(tool: ConversationTool): ConversationExplore | null {
  if (tool.status === "failed" || tool.status === "incomplete") return null;
  const entries = extractExploreEntries(tool);
  if (!entries.length) return null;
  // 仅将“探索型”步骤折叠为 explore；真正执行类命令仍保留为普通 tool。
  if (entries.some((entry) => entry.kind === "run")) return null;
  const status: ConversationExplore["status"] = tool.status === "started" ? "exploring" : "explored";
  return { kind: "explore", id: `explore_${tool.id}` as any, status, entries };
}

function extractExploreEntries(tool: ConversationTool): ExploreEntry[] {
  const toolType = String(tool.toolType ?? "").trim();
  const toolTypeLower = toolType.toLowerCase();

  if (isCommandLikeTool(toolTypeLower)) {
    const command = extractCommand(tool);
    if (!command) return [];
    return parseCommandToExploreEntries(command);
  }

  const input = tryParseJson(tool.detail);
  if (!input) return [];

  // Claude Code 常见工具（启发式）：read/search/list。
  if (toolTypeLower === "read_file" || toolTypeLower === "readfile" || toolTypeLower === "read") {
    const p = asString(input.path ?? input.file ?? input.filePath ?? input.file_path);
    return p ? [toReadEntry(p)] : [];
  }
  if (toolTypeLower === "grep") {
    const query = asString(input.query ?? input.pattern ?? input.q);
    const p = asString(input.path ?? input.cwd ?? input.root);
    const label = p ? `${query} in ${p}` : query;
    return query ? [{ kind: "search", label: label.trim() }] : [];
  }
  if (toolTypeLower === "glob") {
    const pattern = asString(input.pattern ?? input.glob ?? input.q);
    const p = asString(input.path ?? input.cwd ?? input.root);
    if (pattern) {
      const label = p ? `${pattern} in ${p}` : pattern;
      return [{ kind: "search", label: label.trim() }];
    }
    return p ? [{ kind: "list", label: p.trim() }] : [];
  }
  if (toolTypeLower === "search_files" || toolTypeLower === "searchfiles" || toolTypeLower === "search") {
    const query = asString(input.query ?? input.pattern ?? input.q);
    const p = asString(input.path ?? input.cwd ?? input.root);
    const label = p ? `${query} in ${p}` : query;
    return query ? [{ kind: "search", label: label.trim() }] : [];
  }
  if (
    toolTypeLower === "list_files" ||
    toolTypeLower === "listfiles" ||
    toolTypeLower === "list_directory" ||
    toolTypeLower === "listdirectory" ||
    toolTypeLower === "list"
  ) {
    const p = asString(input.path ?? input.dir ?? input.cwd);
    return [{ kind: "list", label: (p || ".").trim() }];
  }

  return [];
}

function isCommandLikeTool(toolTypeLower: string): boolean {
  if (toolTypeLower === "commandexecution") return true;
  if (toolTypeLower === "command_execution") return true;
  if (toolTypeLower === "bash") return true;
  return false;
}

function extractCommand(tool: ConversationTool): string | null {
  const input = tryParseJson(tool.detail);
  const output = tool.output ? tryParseJson(tool.output) : null;
  const command =
    asString(input?.command ?? input?.cmd) ||
    asString(output?.command ?? output?.cmd) ||
    asString(input?.args?.command ?? input?.arguments?.command);
  return command.trim() || null;
}

function extractReviewText(tool: ConversationTool): string {
  const input = tryParseJson(tool.detail);
  const output = tool.output ? tryParseJson(tool.output) : null;
  return (
    asString(input?.review ?? input?.text) ||
    asString(output?.review ?? output?.text) ||
    asString(output?.message ?? output?.result)
  ).trim();
}

function parseCommandToExploreEntries(command: string): ExploreEntry[] {
  const cleaned = String(command ?? "").trim();
  if (!cleaned) return [];

  const segments = cleaned
    .split(/\s*(?:&&|;|\r?\n)\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return [];

  const entries: ExploreEntry[] = [];
  for (const seg of segments) {
    const segEntries = parseCommandSegment(seg);
    if (!segEntries.length) {
      entries.push({ kind: "run", label: abbreviateCommand(seg), detail: seg });
      continue;
    }
    entries.push(...segEntries);
  }

  return dedupeExploreEntries(entries);
}

function parseCommandSegment(segment: string): ExploreEntry[] {
  const tokens = tokenizeCommand(segment);
  if (!tokens.length) return [];

  const inner = unwrapShellWrapper(tokens);
  if (inner && inner !== segment) return parseCommandToExploreEntries(inner);

  const rawCommand = tokens[0] ?? "";
  const commandName = basename(rawCommand).toLowerCase();

  if (READ_COMMANDS.has(commandName)) {
    const paths = collectOperands(tokens).filter(isPathLike);
    return paths.map(toReadEntry);
  }

  if (LIST_COMMANDS.has(commandName)) {
    const paths = collectOperands(tokens).filter(isPathLike);
    return [{ kind: "list", label: (paths[paths.length - 1] ?? commandName).trim() }];
  }

  if (SEARCH_COMMANDS.has(commandName)) {
    const operands = collectOperands(tokens);
    const query = operands[0] ?? "";
    const p = operands.length > 1 && isPathLike(operands[1]) ? operands[1]! : "";
    const label = p ? `${query} in ${p}` : query;
    return query ? [{ kind: "search", label: label.trim() }] : [];
  }

  return [{ kind: "run", label: commandName || "run", detail: segment }];
}

function unwrapShellWrapper(tokens: string[]): string | null {
  const first = basename(tokens[0] ?? "").toLowerCase();
  if (!first) return null;

  if (first === "pwsh.exe" || first === "pwsh" || first === "powershell.exe" || first === "powershell") {
    const idx = tokens.findIndex((t) => t.toLowerCase() === "-command" || t.toLowerCase() === "-c");
    if (idx >= 0 && idx + 1 < tokens.length) return tokens.slice(idx + 1).join(" ").trim();
  }

  if (first === "cmd.exe" || first === "cmd") {
    const idx = tokens.findIndex((t) => t.toLowerCase() === "/c" || t.toLowerCase() === "/k");
    if (idx >= 0 && idx + 1 < tokens.length) return tokens.slice(idx + 1).join(" ").trim();
  }

  if (first === "bash.exe" || first === "bash") {
    const idx = tokens.findIndex((t) => t.toLowerCase() === "-lc" || t.toLowerCase() === "-c");
    if (idx >= 0 && idx + 1 < tokens.length) return tokens.slice(idx + 1).join(" ").trim();
  }

  return null;
}

function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      buf += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }

  if (buf) out.push(buf);
  return out;
}

function collectOperands(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i] ?? "";
    if (!t) continue;
    if (t.startsWith("-") || t.startsWith("/")) continue;
    out.push(t);
  }
  return out;
}

function isPathLike(token: string): boolean {
  return /[\\/]/.test(token) || /\.(\w+)$/.test(token) || token === "." || token === "..";
}

function basename(p: string): string {
  const parts = String(p ?? "").split(/[\\/]/g).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : String(p ?? "");
}

function abbreviateCommand(command: string): string {
  const s = command.trim();
  if (s.length <= 60) return s;
  return `${s.slice(0, 57)}...`;
}

function toReadEntry(p: string): ExploreEntry {
  const trimmed = p.trim();
  const name = basename(trimmed);
  return name && name !== trimmed ? { kind: "read", label: name, detail: trimmed } : { kind: "read", label: trimmed };
}

/** 仅扫描新增条目；同一探索组复用去重索引，按首次出现顺序追加。 */
function mergeExploreEntries(base: ExploreEntry[], next: ExploreEntry[], seen: Set<string>): void {
  for (const entry of next) {
    const key = `${entry.kind}|${entry.label}|${entry.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    base.push(entry);
  }
}

/** 为单条命令去重，复用探索组合并的判定规则。 */
function dedupeExploreEntries(entries: ExploreEntry[]): ExploreEntry[] {
  const out: ExploreEntry[] = [];
  mergeExploreEntries(out, entries, new Set<string>());
  return out;
}

function tryParseProtocolPayload(text: string): { payload: any | null; error: string | null } {
  const raw = String(text ?? "").trim();
  if (!raw) return { payload: null, error: null };
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : raw;
  return tryParseJsonWithError(jsonText);
}

function tryParseJson(text: string): any | null {
  return tryParseJsonWithError(text).payload;
}

function tryParseJsonWithError(text: string): { payload: any | null; error: string | null } {
  const raw = String(text ?? "").trim();
  if (!raw) return { payload: null, error: null };
  if (!(raw.startsWith("{") || raw.startsWith("["))) return { payload: null, error: null };
  try {
    return { payload: JSON.parse(raw), error: null };
  } catch (error) {
    return { payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v ? String(v) : "";
}

