/** 知识工具在会话状态里的中文名；键为去掉 MCP 前缀后的工具 ID。 */
const KNOWLEDGE_TOOL_LABELS: Record<string, string> = {
  "knowledge.source.read": "读取项目来源",
  "knowledge.source.list": "浏览项目目录",
  "knowledge.node.read": "读取知识正文",
  "knowledge.tree.read": "读取知识目录",
  "knowledge.revision.read": "读取待采用版本",
  "knowledge.review.report.read": "读取复检报告",
  "knowledge.asset.submit": "提交知识正文",
};

/** 把 provider 侧工具名转成用户可读文案；未知工具保留去掉 MCP 前缀后的名字。 */
export function formatToolDisplayName(raw: string | null | undefined): string {
  const name = String(raw ?? "").trim();
  if (!name) return "调用工具";
  const id = stripMcpPrefix(name).replace(/^aidt_/i, "");
  return KNOWLEDGE_TOOL_LABELS[id.replace(/_/g, ".").toLowerCase()] ?? id;
}

/** mcp__aidt_runtime__aidt_knowledge_source_read → aidt_knowledge_source_read。 */
function stripMcpPrefix(name: string): string {
  return /^mcp__.+?__(.+)$/i.exec(name)?.[1] ?? name;
}
