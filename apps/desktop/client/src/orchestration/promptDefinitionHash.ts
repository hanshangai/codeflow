import crypto from "node:crypto";

/** 计算冻结执行配置摘要，排除任务正文和解析时刻等动态证据。 */
export function buildPromptDefinitionHash(
  envelope: Record<string, unknown>,
  workflowSnapshotHash: string,
  nodeId: string,
  roleSnapshotHash: string,
): string {
  const meta = asRecord(envelope.meta);
  const knowledge = asRecord(envelope.knowledge);
  const skills = asRecord(envelope.skills);
  const runtime = asRecord(envelope.runtime);
  return hashFingerprint({
    schemaVersion: envelope.schemaVersion ?? null,
    workflowSnapshotHash,
    nodeId,
    intent: meta.intent ?? null,
    roleSnapshotHash,
    knowledgeCatalogs: normalizeKnowledgeDefinitionCatalogs(knowledge.catalogs),
    ...(knowledge.projectSpecifications ? { projectSpecifications: knowledge.projectSpecifications } : {}),
    skills: normalizePromptDefinitionItems(skills.items, ["updatedAt"]),
    runtimePolicy: runtime.runtimePolicy ?? null,
    toolRegistry: runtime.toolRegistry ?? null,
    executionProfiles: normalizePromptDefinitionItems(runtime.executionProfiles, ["updatedAt"]),
  });
}

/** 移除知识解析时刻等非行为字段，保留影响执行的目录定义。 */
function normalizeKnowledgeDefinitionCatalogs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const catalog = omitPromptDefinitionFields(item, ["createdAt", "warnings", "inlineItems"]);
    return {
      ...catalog,
      inlineItems: normalizePromptDefinitionItems(asRecord(item).inlineItems, ["injectedAt"]),
    };
  });
}

/** 归一化一组冻结定义，排除指定的非语义字段。 */
function normalizePromptDefinitionItems(value: unknown, excludedFields: readonly string[]): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => omitPromptDefinitionFields(item, excludedFields));
}

/** 复制冻结定义并移除非语义字段。 */
function omitPromptDefinitionFields(value: unknown, excludedFields: readonly string[]): Record<string, unknown> {
  const excluded = new Set(excludedFields);
  return Object.fromEntries(Object.entries(asRecord(value)).filter(([key]) => !excluded.has(key)));
}

/** 将未知值收窄为普通记录。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 使用现有 JSON 字段顺序计算兼容历史度量的 SHA-256。 */
function hashFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
