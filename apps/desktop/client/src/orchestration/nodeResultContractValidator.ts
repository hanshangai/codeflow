import type {
  AttachmentFormat,
  AttachmentKind,
  ArtifactId,
  NodeContractValidationIssue,
  NodeExecutionEnvelope,
  NodeExecutionFile,
  NodeNextAction,
  NodeResultContractValidationResult,
  NodeResultField,
  NodeResultFieldValidationResult,
  NodeResultFileRef,
  NodeResultFileValidationResult,
  NodeReviewVerdict,
  OrchestrationId,
  RoleDefinition,
  RoleFieldDefinition,
  RoleFieldType,
  RoleOutputFileDefinition,
  RoleOutputFormat,
} from "@codeflowai/shared";
import {
  normalizeRoleOutputDefinition,
} from "@codeflowai/shared";

type ValidationArgs = {
  instanceId: OrchestrationId;
  nodeId: string;
  resultName: string;
  role: Pick<RoleDefinition, "outputDefinition">;
  answer: NodeExecutionEnvelope;
  nextAction: NodeNextAction;
  reviewVerdict: NodeReviewVerdict;
};

type AnswerFile = {
  key: string | null;
  path: string;
  summary: string | null;
  kind: AttachmentKind | null;
  kindRaw: string | null;
  format: AttachmentFormat | null;
  formatRaw: string | null;
  language: string | null;
  source: "contract" | "attachment";
  schemaPath: string;
};

const CONTRACT_VERSION = "node-result-contract/v1";

const FORMAT_EXTENSION_MAP: Record<RoleOutputFormat, string[]> = {
  markdown: [".md", ".markdown"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  text: [".txt", ".text", ".log", ".diff", ".patch", ".csv", ".tsv"],
  html: [".html", ".htm"],
  javascript: [".js", ".mjs", ".cjs"],
  css: [".css"],
  sql: [".sql"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"],
};

const ATTACHMENT_KIND_VALUES: AttachmentKind[] = [
  "source",
  "document",
  "data",
  "image",
  "diff",
  "patch",
  "log",
  "archive",
  "binary",
  "unknown",
];
const ATTACHMENT_KINDS = new Set<AttachmentKind>(ATTACHMENT_KIND_VALUES);

const LEGACY_ATTACHMENT_FORMAT_VALUES: AttachmentFormat[] = [
  "markdown",
  "json",
  "yaml",
  "text",
  "html",
  "javascript",
  "css",
  "sql",
  "image",
  "source",
  "diff",
  "patch",
  "log",
  "binary",
  "archive",
  "unknown",
];
const LEGACY_ATTACHMENT_FORMATS = new Set<AttachmentFormat>(LEGACY_ATTACHMENT_FORMAT_VALUES);

/** 格式化动态附件 kind 合法值，直接放进阻断问题反馈给模型。 */
function formatAttachmentKindAllowedValues(): string {
  return ATTACHMENT_KIND_VALUES.join(" / ");
}

/** 格式化兼容 format 合法值，并提醒它不是文件扩展名。 */
function formatAttachmentFormatAllowedValues(): string {
  return LEGACY_ATTACHMENT_FORMAT_VALUES.join(" / ");
}

const ATTACHMENT_EXTENSION_MAP: Partial<Record<AttachmentKind, string[]>> = {
  document: [".md", ".markdown", ".txt", ".text"],
  data: [".json", ".yaml", ".yml", ".csv", ".tsv", ".sql"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"],
  diff: [".diff"],
  patch: [".patch"],
  log: [".log"],
  archive: [".zip", ".gz", ".tar", ".tgz", ".rar", ".7z"],
  binary: [".exe", ".dll", ".so", ".dylib", ".jar", ".war", ".class", ".wasm", ".db", ".sqlite"],
};

const SOURCE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".vue": "vue",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".java": "java",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".php": "php",
  ".rb": "ruby",
  ".cs": "csharp",
  ".swift": "swift",
  ".svelte": "svelte",
  ".astro": "astro",
  ".less": "less",
  ".scss": "scss",
  ".sass": "sass",
  ".styl": "stylus",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".gradle": "groovy",
  ".groovy": "groovy",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".ps1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",
  ".lua": "lua",
  ".r": "r",
  ".pl": "perl",
  ".pm": "perl",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".m": "objective-c",
  ".mm": "objective-cpp",
};

const SOURCE_BASENAME_LANGUAGE_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  jenkinsfile: "groovy",
};

/** 校验节点最终输出是否满足角色输出契约，并产出可落表的字段与文件索引事实。 */
export function validateNodeResultContract(args: ValidationArgs): NodeResultContractValidationResult {
  const outputDefinition = normalizeRoleOutputDefinition(args.role.outputDefinition);
  const completion = resolveCompletion(args.nextAction, args.reviewVerdict);
  if (args.nextAction !== "continue") {
    return emptyValidationResult(args.answer, completion, false);
  }

  const blockingIssues: NodeContractValidationIssue[] = [];
  const warnings: NodeContractValidationIssue[] = [];
  const { normalizedFields, fieldResults } = validateOutputFields({
    instanceId: args.instanceId,
    nodeId: args.nodeId,
    resultName: args.resultName,
    answer: args.answer,
    fields: outputDefinition.requiredFields,
    issues: blockingIssues,
  });
  const { normalizedAnswer, normalizedFiles, fileResults } = validateOutputFiles({
    answer: args.answer,
    contracts: outputDefinition.files ?? [],
    fallbackFormat: outputDefinition.format,
    issues: blockingIssues,
    warnings,
  });

  return {
    accepted: blockingIssues.length === 0,
    completion,
    consumable: blockingIssues.length === 0 && completion === "complete",
    contractVersion: CONTRACT_VERSION,
    normalizedAnswer,
    normalizedFields,
    normalizedFiles,
    fieldResults,
    fileResults,
    blockingIssues,
    recoverableIssues: [],
    warnings,
  };
}

/** 将校验结果压缩成 artifact metadata 可保存的报告，避免塞入完整正文。 */
export function toNodeResultValidationReport(validation: NodeResultContractValidationResult): Record<string, unknown> {
  return {
    blockingIssues: validation.blockingIssues,
    recoverableIssues: validation.recoverableIssues,
    warnings: validation.warnings,
    fieldResults: validation.fieldResults,
    fileResults: validation.fileResults,
  };
}

function resolveCompletion(nextAction: NodeNextAction, reviewVerdict: NodeReviewVerdict): NodeResultContractValidationResult["completion"] {
  if (nextAction !== "continue") return "decision";
  return reviewVerdict === "pass" ? "complete" : "partial";
}

function emptyValidationResult(
  answer: NodeExecutionEnvelope,
  completion: NodeResultContractValidationResult["completion"],
  consumable: boolean,
): NodeResultContractValidationResult {
  return {
    accepted: true,
    completion,
    consumable,
    contractVersion: CONTRACT_VERSION,
    normalizedAnswer: answer,
    normalizedFields: [],
    normalizedFiles: [],
    fieldResults: [],
    fileResults: [],
    blockingIssues: [],
    recoverableIssues: [],
    warnings: [],
  };
}

function validateOutputFields(args: {
  instanceId: OrchestrationId;
  nodeId: string;
  resultName: string;
  answer: NodeExecutionEnvelope;
  fields: RoleFieldDefinition[];
  issues: NodeContractValidationIssue[];
}): {
  normalizedFields: NodeResultField[];
  fieldResults: NodeResultFieldValidationResult[];
} {
  const values = collectAnswerFields(args.answer);
  const normalizedFields: NodeResultField[] = [];
  const fieldResults: NodeResultFieldValidationResult[] = [];

  for (const field of args.fields) {
    const rawValue = values.get(field.key);
    if (isMissingFieldValue(rawValue, field.valueType)) {
      if (field.required) {
        const validationIssue = makeIssue("OUTPUT_FIELD_MISSING", `缺少必填输出字段：${field.label || field.key}`, `answer.fields.${field.key}`);
        args.issues.push(validationIssue);
        fieldResults.push({ fieldKey: field.key, status: "missing", issue: validationIssue });
      } else {
        fieldResults.push({ fieldKey: field.key, status: "missing" });
      }
      continue;
    }

    const invalidMessage = validateFieldValue(rawValue, field.valueType);
    if (invalidMessage) {
      const validationIssue = makeIssue(
        "OUTPUT_FIELD_INVALID",
        `${field.label || field.key} 格式不符合 ${field.valueType}：${invalidMessage}`,
        `answer.fields.${field.key}`,
      );
      args.issues.push(validationIssue);
      fieldResults.push({ fieldKey: field.key, status: "invalid", issue: validationIssue });
      continue;
    }

    normalizedFields.push({
      id: "",
      artifactId: "" as ArtifactId,
      instanceId: args.instanceId,
      nodeId: args.nodeId,
      resultName: args.resultName,
      fieldKey: field.key,
      label: field.label,
      valueType: field.valueType,
      valueJson: JSON.stringify(rawValue),
      valuePreview: previewValue(rawValue),
      required: field.required,
      source: "model",
      validationStatus: "valid",
      createdAt: 0,
      updatedAt: 0,
    });
    fieldResults.push({ fieldKey: field.key, status: "valid" });
  }

  return { normalizedFields, fieldResults };
}

function validateOutputFiles(args: {
  answer: NodeExecutionEnvelope;
  contracts: RoleOutputFileDefinition[];
  fallbackFormat: RoleOutputFormat;
  issues: NodeContractValidationIssue[];
  warnings: NodeContractValidationIssue[];
}): {
  normalizedAnswer: NodeExecutionEnvelope;
  normalizedFiles: NodeResultFileRef[];
  fileResults: NodeResultFileValidationResult[];
} {
  const answerFiles = collectAnswerFiles(args.answer);
  const answerAttachments = collectAnswerAttachments(args.answer);
  const contractsByKey = new Map(args.contracts.map((contract) => [String(contract.key ?? "").trim(), contract] as const));
  const contractHint = formatFileContractHint(args.contracts, args.fallbackFormat);
  const matchedRequiredKeys = new Set<string>();
  const seenFileKeys = new Set<string>();
  const seenAttachmentKeys = new Set<string>();
  const normalizedFiles: NodeResultFileRef[] = [];
  const fileResults: NodeResultFileValidationResult[] = [];
  const normalizedAttachments = (args.answer.attachments ?? []).map((attachment) => ({ ...attachment }));

  for (const answerFile of answerFiles) {
    let contract: RoleOutputFileDefinition | null = null;
    if (answerFile.key) {
      if (seenFileKeys.has(answerFile.key)) {
        const duplicateIssue = makeIssue(
          "OUTPUT_FILE_KEY_DUPLICATED",
          [
            `${filePath(answerFile, "key")}="${answerFile.key}" 与前面的文件 key 重复。`,
            "file-set 中每个 answer.files[].key（交付物编号）必须唯一；key 是角色定义“输出”里配置的文件标识，不是文件名或业务简称。",
            contractHint,
            `请保留一个 key="${answerFile.key}" 的文件引用，或把多份内容合并到该 key 对应的文件；如果确实要拆成多个交付文件，请先在角色输出配置里新增不同 key。`,
          ].join(" "),
          filePath(answerFile, "key"),
        );
        args.issues.push(duplicateIssue);
        fileResults.push({ fileKey: answerFile.key, source: "contract", path: answerFile.path, status: "invalid", issue: duplicateIssue });
        continue;
      }
      seenFileKeys.add(answerFile.key);
      contract = contractsByKey.get(answerFile.key) ?? null;
      if (!contract && contractsByKey.size > 0) {
        const unknownIssue = makeIssue(
          "OUTPUT_FILE_KEY_UNKNOWN",
          [
            `${filePath(answerFile, "key")}="${answerFile.key}" 不在当前角色定义“输出”配置中。`,
            "answer.files[].key（交付物编号）必须严格等于已配置的文件 key，不能临时自造业务名。",
            contractHint,
            "如果只是文件名不同，请保留上面列出的 key，只修改 path；如果这是本轮动态材料，请移到 answer.attachments；如果需要新的正式交付文件 key，请先修改角色输出配置后再执行节点。",
          ].join(" "),
          filePath(answerFile, "key"),
        );
        args.issues.push(unknownIssue);
        fileResults.push({ fileKey: answerFile.key, source: "contract", path: answerFile.path, status: "invalid", issue: unknownIssue });
        continue;
      }
    } else if (args.contracts.length > 0) {
      const missingKeyIssue = makeIssue(
        "OUTPUT_FILE_KEY_MISSING",
        [
          `${filePath(answerFile, "key")} 缺失。`,
          "文件输出必须返回稳定 key（交付物编号），平台用它生成下游 file_refs。",
          contractHint,
        ].join(" "),
        filePath(answerFile, "key"),
      );
      args.issues.push(missingKeyIssue);
      fileResults.push({ source: "contract", path: answerFile.path, status: "invalid", issue: missingKeyIssue });
      continue;
    }

    const fileKey = String(contract?.key ?? answerFile.key ?? "").trim() || null;
    if (fileKey) matchedRequiredKeys.add(fileKey);
    const format = contract?.format ?? args.fallbackFormat;
    const allowedExtensions = contract?.allowedExtensions?.length
      ? contract.allowedExtensions
      : FORMAT_EXTENSION_MAP[format];
    if (!hasAllowedExtension(answerFile.path, allowedExtensions)) {
      const suffixIssue = makeIssue(
        "OUTPUT_FILE_EXTENSION_INVALID",
        `${filePath(answerFile, "path")}="${answerFile.path}" 后缀不符合 ${format} 格式要求；允许后缀：${allowedExtensions.join(", ")}。请先生成或重命名为对应格式文件后再提交。`,
        filePath(answerFile, "path"),
      );
      args.issues.push(suffixIssue);
      fileResults.push({ fileKey, source: "contract", path: answerFile.path, status: "invalid", issue: suffixIssue });
      continue;
    }

    normalizedFiles.push({
      artifactId: "" as ArtifactId,
      fileKey,
      source: "contract",
      contractKey: fileKey,
      relPath: answerFile.path,
      workspacePath: answerFile.path,
      summary: answerFile.summary,
      format,
      readRequired: true,
    });
    fileResults.push({ fileKey, source: "contract", path: answerFile.path, status: "valid" });
  }

  for (const [attachmentIndex, attachment] of answerAttachments.entries()) {
    if (attachment.key) {
      if (seenAttachmentKeys.has(attachment.key)) {
        const duplicateIssue = makeIssue(
          "OUTPUT_ATTACHMENT_KEY_DUPLICATED",
          `${filePath(attachment, "key")}="${attachment.key}" 与前面的附件 key 重复。附件 key 是本轮可读标签；如果不需要稳定标签，可以省略 key。`,
          filePath(attachment, "key"),
        );
        args.issues.push(duplicateIssue);
        fileResults.push({ fileKey: attachment.key, source: "attachment", path: attachment.path, status: "invalid", issue: duplicateIssue });
        continue;
      }
      seenAttachmentKeys.add(attachment.key);
    }
    const validation = validateAttachmentPolicy(attachment);
    if (!validation.accepted) {
      args.issues.push(validation.issue);
      fileResults.push({ fileKey: attachment.key, source: "attachment", path: attachment.path, status: "invalid", issue: validation.issue });
      continue;
    }
    if (validation.warning) args.warnings.push(validation.warning);
    normalizedAttachments[attachmentIndex] = {
      ...normalizedAttachments[attachmentIndex],
      kind: validation.kind,
      format: validation.format,
      language: validation.language,
    };
    normalizedFiles.push({
      artifactId: "" as ArtifactId,
      fileKey: attachment.key,
      source: "attachment",
      contractKey: null,
      relPath: attachment.path,
      workspacePath: attachment.path,
      summary: attachment.summary,
      kind: validation.kind,
      format: validation.format,
      readRequired: true,
    });
    fileResults.push({
      fileKey: attachment.key,
      source: "attachment",
      path: attachment.path,
      status: validation.warning ? "warning" : "valid",
      issue: validation.warning ?? null,
    });
  }

  for (const contract of args.contracts) {
    const key = String(contract.key ?? "").trim();
    if (!contract.required || !key || matchedRequiredKeys.has(key)) continue;
    const missingIssue = makeIssue(
      "OUTPUT_FILE_REQUIRED_MISSING",
      `缺少必交付文件：${describeFileContract(contract, args.fallbackFormat)}。请在 answer.files 中增加 key="${key}" 的文件引用。`,
      "answer.files",
    );
    args.issues.push(missingIssue);
    fileResults.push({ fileKey: key, source: "contract", status: "invalid", issue: missingIssue });
  }

  return {
    normalizedAnswer: withNormalizedAttachments(args.answer, normalizedAttachments),
    normalizedFiles,
    fileResults,
  };
}

function collectAnswerFields(answer: NodeExecutionEnvelope): Map<string, unknown> {
  const values = new Map<string, unknown>();
  if (answer.mode === "structured" && isRecord(answer.data)) {
    for (const [key, value] of Object.entries(answer.data)) values.set(key, value);
  }
  if (isRecord(answer.fields)) {
    for (const [key, value] of Object.entries(answer.fields)) values.set(key, value);
  }
  return values;
}

function collectAnswerFiles(answer: NodeExecutionEnvelope): AnswerFile[] {
  if (answer.mode === "file") return [toAnswerFile(answer.file, "answer.file")];
  if (answer.mode === "file-set") return answer.files.map((file, index) => toAnswerFile(file, `answer.files[${index}]`));
  return [];
}

function collectAnswerAttachments(answer: NodeExecutionEnvelope): AnswerFile[] {
  return (answer.attachments ?? []).map((file, index) => toAnswerFile(file, `answer.attachments[${index}]`, "attachment"));
}

function toAnswerFile(
  file: NodeExecutionFile & { kind?: string | null; format?: string | null; language?: string | null },
  schemaPath: string,
  source: "contract" | "attachment" = "contract",
): AnswerFile {
  const kindRaw = String(file.kind ?? "").trim() || null;
  const formatRaw = String(file.format ?? "").trim() || null;
  return {
    key: String(file.key ?? "").trim() || null,
    path: String(file.path ?? "").trim(),
    summary: String(file.summary ?? "").trim() || null,
    kind: source === "attachment" ? normalizeAttachmentKindValue(kindRaw) : null,
    kindRaw,
    format: source === "attachment" ? normalizeAttachmentFormatValue(formatRaw) : normalizeAnswerFileFormat(formatRaw),
    formatRaw,
    language: normalizeAttachmentLanguage(file.language),
    source,
    schemaPath,
  };
}

function normalizeAnswerFileFormat(raw: unknown): RoleOutputFormat | null {
  const value = String(raw ?? "").trim();
  return Object.prototype.hasOwnProperty.call(FORMAT_EXTENSION_MAP, value) ? value as RoleOutputFormat : null;
}

/** 归一化动态附件用途分类；这里不影响正式交付物格式集合。 */
function normalizeAttachmentKindValue(raw: unknown): AttachmentKind | null {
  const value = String(raw ?? "").trim();
  return ATTACHMENT_KINDS.has(value as AttachmentKind) ? value as AttachmentKind : null;
}

/** 归一化旧版动态附件 format；仅用于兼容旧提交和辅助推断 kind。 */
function normalizeAttachmentFormatValue(raw: unknown): AttachmentFormat | null {
  const value = String(raw ?? "").trim();
  return LEGACY_ATTACHMENT_FORMATS.has(value as AttachmentFormat) ? value as AttachmentFormat : null;
}

/** 归一化源码语言标签，仅保留展示和索引用的小写安全片段。 */
function normalizeAttachmentLanguage(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const normalized = value.replace(/[^a-z0-9_+#.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 40) : null;
}

function isMissingFieldValue(value: unknown, valueType: RoleFieldType): boolean {
  if (value == null) return true;
  if (valueType === "json") return false;
  return typeof value === "string" ? !value.trim() : false;
}

function validateFieldValue(value: unknown, valueType: RoleFieldType): string | null {
  if (valueType === "json") {
    try {
      JSON.stringify(value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "无法序列化为 JSON";
    }
  }
  if (valueType === "text" || valueType === "markdown" || valueType === "file-path") {
    return typeof value === "string" ? null : "字段值必须是字符串";
  }
  return null;
}

function previewValue(value: unknown): string | null {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : null;
}

function hasAllowedExtension(filePathValue: string, allowedExtensions: string[]): boolean {
  const normalizedPath = String(filePathValue ?? "").trim().toLowerCase();
  return allowedExtensions.some((extension) => normalizedPath.endsWith(extension.toLowerCase()));
}

/** 根据路径推断附件用途；后缀只用于分类，不作为动态附件的唯一准入规则。 */
function inferAttachmentFromPath(filePathValue: string): { kind: AttachmentKind | null; format: AttachmentFormat | null; language: string | null } {
  const normalizedPath = String(filePathValue ?? "").trim().toLowerCase();
  const sourceLanguage = inferSourceLanguageFromPath(normalizedPath);
  if (sourceLanguage) return { kind: "source", format: null, language: sourceLanguage };
  for (const [kind, extensions] of Object.entries(ATTACHMENT_EXTENSION_MAP) as Array<[AttachmentKind, string[]]>) {
    if (extensions.some((extension) => normalizedPath.endsWith(extension.toLowerCase()))) {
      return { kind, format: inferLegacyFormatFromPath(normalizedPath), language: null };
    }
  }
  return { kind: null, format: null, language: null };
}

/** 推断旧 format 字段的兼容值，供历史数据和审计展示使用。 */
function inferLegacyFormatFromPath(normalizedPath: string): AttachmentFormat | null {
  if (normalizedPath.endsWith(".diff")) return "diff";
  if (normalizedPath.endsWith(".patch")) return "patch";
  if (normalizedPath.endsWith(".log")) return "log";
  for (const [format, extensions] of Object.entries(FORMAT_EXTENSION_MAP) as Array<[RoleOutputFormat, string[]]>) {
    if (extensions.some((extension) => normalizedPath.endsWith(extension.toLowerCase()))) return format;
  }
  if (ATTACHMENT_EXTENSION_MAP.archive?.some((extension) => normalizedPath.endsWith(extension))) return "archive";
  if (ATTACHMENT_EXTENSION_MAP.binary?.some((extension) => normalizedPath.endsWith(extension))) return "binary";
  return null;
}

/** 为源码附件推断展示语言；列表只服务高亮和自动修正，不作为安全白名单。 */
function inferSourceLanguageFromPath(normalizedPath: string): string | null {
  const basename = normalizedPath.split("/").pop() ?? "";
  const basenameLanguage = SOURCE_BASENAME_LANGUAGE_MAP[basename];
  if (basenameLanguage) return basenameLanguage;
  for (const [extension, language] of Object.entries(SOURCE_EXTENSION_LANGUAGE_MAP)) {
    if (normalizedPath.endsWith(extension)) return language;
  }
  return null;
}

/** 校验动态附件用途策略，正式交付物不走这条宽松路径。 */
function validateAttachmentPolicy(attachment: AnswerFile): {
  accepted: true;
  kind: AttachmentKind;
  format: AttachmentFormat | null;
  language: string | null;
  warning?: NodeContractValidationIssue | null;
} | {
  accepted: false;
  issue: NodeContractValidationIssue;
} {
  if (attachment.kindRaw && !attachment.kind) {
    return {
      accepted: false,
      issue: makeIssue(
        "OUTPUT_ATTACHMENT_KIND_INVALID",
        `${filePath(attachment, "kind")}="${attachment.kindRaw}" 不是平台支持的动态附件用途分类。合法值：${formatAttachmentKindAllowedValues()}。`,
        filePath(attachment, "kind"),
      ),
    };
  }

  if (attachment.formatRaw && !attachment.format) {
    return {
      accepted: false,
      issue: makeIssue(
        "OUTPUT_ATTACHMENT_FORMAT_INVALID",
        `${filePath(attachment, "format")}="${attachment.formatRaw}" 不是平台支持的兼容附件格式。format 不是文件扩展名，合法值：${formatAttachmentFormatAllowedValues()}；图片请填 kind="image"，format 可省略或填 "image"，不要填 png/jpg/jpeg/webp。`,
        filePath(attachment, "format"),
      ),
    };
  }

  const inferred = inferAttachmentFromPath(attachment.path);
  const legacyKind = attachment.format ? mapLegacyFormatToKind(attachment.format) : null;
  if (!attachment.kind && !inferred.kind && !legacyKind) {
    return {
      accepted: false,
      issue: makeIssue(
        "OUTPUT_ATTACHMENT_KIND_UNKNOWN",
        `${filePath(attachment, "path")}="${attachment.path}" 无法识别附件用途。请填写 answer.attachments[].kind，合法值：${formatAttachmentKindAllowedValues()}。`,
        filePath(attachment, "path"),
      ),
    };
  }

  const kind = (attachment.kind ?? inferred.kind ?? legacyKind ?? "unknown") as AttachmentKind;
  let format = normalizeAttachmentOutputFormat(attachment.format, inferred.format, kind);
  let language = attachment.language ?? (kind === "source" ? inferred.language : null);
  let warning: NodeContractValidationIssue | null = null;

  if (attachment.kind && inferred.kind && !isCompatibleAttachmentKind(attachment.kind, inferred.kind)) {
    return {
      accepted: false,
      issue: makeIssue(
        "OUTPUT_ATTACHMENT_KIND_MISMATCH",
        `${filePath(attachment, "path")}="${attachment.path}" 更像 ${inferred.kind} 附件，不能标记为 ${attachment.kind}。请修正 kind，或改用更准确的附件路径。`,
        filePath(attachment, "kind"),
      ),
    };
  }

  if (attachment.format && inferred.kind && !isCompatibleAttachmentFormat(attachment.format, inferred.kind, inferred.format)) {
    return {
      accepted: false,
      issue: makeIssue(
        "OUTPUT_ATTACHMENT_FORMAT_MISMATCH",
        `${filePath(attachment, "path")}="${attachment.path}" 更像 ${inferred.kind} 附件，不能使用兼容 format=${attachment.format}。请优先填写 kind，或修正 format。`,
        filePath(attachment, "format"),
      ),
    };
  }

  if (!attachment.kind && attachment.format === "source") {
    format = null;
    language = attachment.language ?? inferred.language;
    warning = makeWarning(
      "OUTPUT_ATTACHMENT_KIND_NORMALIZED",
      `${filePath(attachment, "format")}="source" 是旧版写法，已归一化为 kind=source。`,
      filePath(attachment, "kind"),
    );
  } else if (!attachment.kind && attachment.format === "text" && inferred.kind === "source") {
    language = attachment.language ?? inferred.language;
    warning = makeWarning(
      "OUTPUT_ATTACHMENT_KIND_INFERRED",
      `${filePath(attachment, "path")}="${attachment.path}" 是源码附件，已按路径归一化为 kind=source；format=text 仅作为兼容内容格式保留。`,
      filePath(attachment, "kind"),
    );
  }

  if (kind === "source") {
    language = language ?? inferred.language;
  }

  return { accepted: true, kind, format, language, warning };
}

/** 将旧 format 字段映射为用途分类，只用于兼容旧提交。 */
function mapLegacyFormatToKind(format: AttachmentFormat): AttachmentKind | null {
  if (format === "source") return "source";
  if (format === "markdown" || format === "text") return "document";
  if (format === "json" || format === "yaml" || format === "sql") return "data";
  if (format === "html" || format === "javascript" || format === "css") return "source";
  if (format === "image") return "image";
  if (format === "diff" || format === "patch" || format === "log" || format === "archive" || format === "binary" || format === "unknown") return format;
  return null;
}

/** 归一化附件 format 兼容字段；source 作为旧用途值时不继续写回 format。 */
function normalizeAttachmentOutputFormat(
  explicitFormat: AttachmentFormat | null,
  inferredFormat: AttachmentFormat | null,
  kind: AttachmentKind,
): AttachmentFormat | null {
  if (explicitFormat === "source") return null;
  if (explicitFormat) return explicitFormat;
  if (kind === "source") return null;
  return inferredFormat;
}

/** 判断显式附件用途和路径推断用途是否可兼容，兼容不代表安全扫描通过。 */
function isCompatibleAttachmentKind(explicitKind: AttachmentKind, inferredKind: AttachmentKind): boolean {
  if (explicitKind === inferredKind) return true;
  if (explicitKind === "unknown") return true;
  return false;
}

/** 判断兼容 format 与路径推断用途是否可兼容，兼容不代表安全扫描通过。 */
function isCompatibleAttachmentFormat(
  explicitFormat: AttachmentFormat,
  inferredKind: AttachmentKind,
  inferredFormat: AttachmentFormat | null,
): boolean {
  if (explicitFormat === inferredFormat) return true;
  if (explicitFormat === "unknown") return true;
  if (explicitFormat === "source") return inferredKind === "source";
  if (explicitFormat === "text") return inferredKind === "source" || inferredKind === "diff" || inferredKind === "patch" || inferredKind === "log";
  if (explicitFormat === "html" || explicitFormat === "javascript" || explicitFormat === "css") return inferredKind === "source";
  return false;
}

/** 将附件归一化写回 answer，确保后续持久化和下游索引用同一份事实。 */
function withNormalizedAttachments(
  answer: NodeExecutionEnvelope,
  attachments: NonNullable<NodeExecutionEnvelope["attachments"]>,
): NodeExecutionEnvelope {
  if (!attachments.length) return answer;
  return { ...answer, attachments } as NodeExecutionEnvelope;
}

/** 生成人可读的角色输出文件 key 提示，直接用于模型恢复提示和 UI 预览。 */
function formatFileContractHint(contracts: RoleOutputFileDefinition[], fallbackFormat: RoleOutputFormat): string {
  const descriptions = contracts
    .map((contract) => describeFileContract(contract, fallbackFormat))
    .filter(Boolean);
  return descriptions.length
    ? `当前角色允许的文件 key（交付物编号）：${descriptions.join("；")}。`
    : "当前角色没有配置固定文件 key。";
}

/** 描述单个角色输出文件配置，避免错误信息只暴露内部 key。 */
function describeFileContract(contract: RoleOutputFileDefinition, fallbackFormat: RoleOutputFormat): string {
  const key = String(contract.key ?? "").trim();
  if (!key) return "";
  const name = String(contract.name ?? "").trim();
  const format = contract.format ?? fallbackFormat;
  const required = contract.required ? "必填" : "可选";
  const extensions = contract.allowedExtensions?.length
    ? contract.allowedExtensions
    : FORMAT_EXTENSION_MAP[format];
  const suffix = extensions.length ? `，后缀 ${extensions.join("/")}` : "";
  return name
    ? `${key}（${name}，格式 ${format}，${required}${suffix}）`
    : `${key}（格式 ${format}，${required}${suffix}）`;
}

function filePath(file: AnswerFile, property: string): string {
  return `${file.schemaPath}.${property}`;
}

function makeIssue(code: string, message: string, path: string | null): NodeContractValidationIssue {
  return {
    code,
    message,
    path,
    severity: "blocking",
  };
}

function makeWarning(code: string, message: string, path: string | null): NodeContractValidationIssue {
  return {
    code,
    message,
    path,
    severity: "warning",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
