import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getArtifactWritePolicyFromMetadata,
} from "@codeflowai/shared";
import type {
  AttachmentKind,
  Artifact,
  ArtifactMetadata,
  ArtifactManifest,
  ArtifactOutputMode,
  ArtifactPersistenceMode,
  ArtifactRevisionMetadata,
  ArtifactWorkspaceStatus,
  NodeExecutionEnvelope,
  NodeResultContractValidationResult,
  OutputWritePolicy,
  WorkflowNode,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { readExistingCodeflowaiConfig } from "../codeflowai/codeflowaiConfig.js";
import { isBinaryFile } from "../fs/fsHelpers.js";
import { decodeTextBuffer } from "../fs/textEncoding.js";
import type { WorkspacePathIndex } from "../fs/workspacePathIndexService.js";

type WorkspaceFileEntrySnapshot = {
  relPath: string;
  stagingPath: string | null;
  publishedPath: string | null;
  status: Exclude<ArtifactWorkspaceStatus, "none">;
  contentHash: string;
  sizeBytes: number;
  actualContent: string | null;
  actualBuffer: Buffer;
};

type NormalizedEnvelopeFile = {
  path: string;
  content: string | null;
  sourcePath?: string;
};

type WorkspaceWriteResult = {
  baseDir: string;
  workspaceStatus: ArtifactWorkspaceStatus;
  stagingPath: string | null;
  publishedPath: string | null;
  fileEntries: WorkspaceFileEntrySnapshot[];
};

const MAX_ARTIFACT_PATH_SEGMENT_LENGTH = 120;
const MAX_ARTIFACT_PATH_SEGMENT_BYTES = 255;
const WINDOWS_INVALID_PATH_SEGMENT_CHAR_RE = /[<>:"|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_PATH_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type ArtifactOutputPathValidationIssueCode =
  | "ARTIFACT_PATH_INVALID"
  | "ARTIFACT_FILE_MISSING"
  | "ARTIFACT_PATH_RESOLUTION_MISMATCH"
  | "ARTIFACT_PATH_NOT_FILE";

export type ArtifactOutputPathValidationIssue = {
  code: ArtifactOutputPathValidationIssueCode;
  returnedPath: string;
  expectedPath?: string | null;
  message: string;
};

export class ArtifactPersistenceService {
  constructor(
    private readonly deps: {
      db: ClientDb;
      workspacePath: string;
      workspaceId?: WorkspaceId | null;
      workspacePathIndex?: WorkspacePathIndex | null;
    },
  ) {}

  /** 持久化节点输出，并把工作区文件快照及交付契约元数据写入 artifact 索引。 */
  persist(args: {
    instanceId: string;
    nodeId: string;
    nodeLabel: string;
    kind: string;
    schemaRef: string | null;
    version: number;
    threadId?: string | null;
    roleId?: string | null;
    node: WorkflowNode;
    envelope: NodeExecutionEnvelope;
    defaultBaseDir?: string | null;
    metadata?: ArtifactMetadata | null;
    contractValidation?: NodeResultContractValidationResult | null;
    /** 仅在角色交付路径规则已被平台完整解析时启用根目录守卫；未解析时保持既有落盘行为。 */
    enableRootedPathGuard?: boolean;
  }): Artifact {
    const workspaceBackedPaths = collectWorkspaceBackedPaths(args.envelope);
    const materializedEnvelope = materializeEnvelopeForPersistence(args.envelope, this.deps.workspacePath);
    const outputMode = materializedEnvelope.mode;
    const writePolicy = resolveWritePolicy(args.node, outputMode);
    const configuredBaseDir = sanitizeArtifactBaseDir(writePolicy.baseDir ?? "");
    const preferredBaseDir = sanitizeArtifactBaseDir(configuredBaseDir || args.defaultBaseDir || `codeflowai/artifacts/${args.instanceId}/${args.nodeId}`);
    // 最后防线：根目录路径不得写盘，避免绕过提交期校验污染 workflowDocsRoot 根目录。
    if (args.enableRootedPathGuard && writePolicy.persistenceMode !== "db-only") {
      const rootedAtDocsRoot = normalizeEnvelopeFiles(materializedEnvelope)
        .map((file) => String(file.path ?? ""))
        .filter((filePath) => isArtifactPathDirectlyUnderWorkflowDocsRoot(this.deps.workspacePath, filePath));
      if (rootedAtDocsRoot.length) {
        throw new Error(`工件路径缺少业务目录，拒绝落盘：${rootedAtDocsRoot.join("、")}。请按路径规则给出的完整业务路径重新提交。`);
      }
    }
    const workspaceResult = writePolicy.persistenceMode === "db-only"
      ? this.buildDbOnlyWorkspaceResult({
          workspacePath: this.deps.workspacePath,
          preferredBaseDir,
          envelope: materializedEnvelope,
          workspaceBackedPaths,
        })
      : this.writeToWorkspace({
          workspacePath: this.deps.workspacePath,
          preferredBaseDir,
          envelope: materializedEnvelope,
          writePolicy,
          workspaceBackedPaths,
          allowRootedBaseDirOverride: !configuredBaseDir && Boolean(args.defaultBaseDir),
        });
    const persistedEnvelope = writePolicy.persistenceMode === "db-only"
      ? materializedEnvelope
      : buildPersistedEnvelope(materializedEnvelope, workspaceResult.fileEntries);

    const manifest: ArtifactManifest = {
      summary: extractEnvelopeSummary(persistedEnvelope),
      changedFiles: extractChangedFiles(persistedEnvelope),
      files: workspaceResult.fileEntries.map((item, index) => {
        const contractMetadata = resolveFileContractMetadata(args.contractValidation, materializedEnvelope, index);
        return {
          fileKey: contractMetadata?.fileKey ?? null,
          fileRole: contractMetadata?.fileRole ?? "contract",
          contractKey: contractMetadata?.contractKey ?? null,
          relPath: item.relPath,
          summary: contractMetadata?.summary ?? item.relPath,
          format: contractMetadata?.format ?? null,
        };
      }),
    };

    const artifact = this.deps.db.orchArtifacts.create({
      instanceId: args.instanceId as any,
      nodeId: args.nodeId,
      kind: args.kind,
      version: args.version,
      title: `${args.nodeLabel} 输出 v${args.version}`,
      schemaRef: args.schemaRef,
      status: "draft",
      contentJson: JSON.stringify(persistedEnvelope),
      metadata: {
        ...(args.metadata ?? {}),
        roleId: args.roleId ?? "",
        threadId: args.threadId ?? "",
        artifactWritePolicy: writePolicy,
      },
      persistenceMode: writePolicy.persistenceMode,
      payloadMode: outputMode,
      workspaceStatus: workspaceResult.workspaceStatus,
      workspaceBaseDir: workspaceResult.baseDir,
      stagingPath: workspaceResult.stagingPath,
      publishedPath: workspaceResult.publishedPath,
      contentHash: hashText(JSON.stringify(persistedEnvelope)),
      manifest,
    });

    if (workspaceResult.fileEntries.length) {
      this.deps.db.orchArtifactFiles.replaceForArtifact(
        artifact.id,
        workspaceResult.fileEntries.map(({ actualContent: _actualContent, actualBuffer: _actualBuffer, ...entry }, index) => {
          const contractMetadata = resolveFileContractMetadata(args.contractValidation, materializedEnvelope, index);
          return {
            ...entry,
            fileKey: contractMetadata?.fileKey ?? null,
            fileRole: contractMetadata?.fileRole ?? "contract",
            format: contractMetadata?.format ?? null,
            contractKey: contractMetadata?.contractKey ?? null,
            summary: contractMetadata?.summary ?? null,
            validationStatus: contractMetadata?.validationStatus ?? null,
          };
        }),
      );
    }
    return artifact;
  }

  createRevision(args: {
    basedOn: Artifact;
    nodeLabel: string;
    version: number;
    envelope: NodeExecutionEnvelope;
    threadId?: string | null;
    roleId?: string | null;
    note?: string | null;
    metadata?: ArtifactMetadata | null;
    contractValidation?: NodeResultContractValidationResult | null;
  }): Artifact {
    const writePolicy = resolvePersistedWritePolicy(args.basedOn, args.envelope.mode);
    const revisionMetadata: ArtifactRevisionMetadata = {
      source: "human",
      basedOnArtifactId: args.basedOn.id,
      basedOnVersion: args.basedOn.version,
      basedOnStatus: args.basedOn.status,
      note: String(args.note ?? "").trim() || null,
      editedAt: Date.now(),
    };
    const metadata = buildHumanRevisionMetadata(args.basedOn.metadata, args.metadata, revisionMetadata);
    return this.persist({
      instanceId: String(args.basedOn.instanceId),
      nodeId: args.basedOn.nodeId,
      nodeLabel: args.nodeLabel,
      kind: args.basedOn.kind,
      schemaRef: args.basedOn.schemaRef ?? null,
      version: args.version,
      threadId: args.threadId ?? null,
      roleId: args.roleId ?? null,
      node: {
        id: args.basedOn.nodeId,
        type: "role",
        label: args.nodeLabel,
        roleId: args.roleId ? (args.roleId as any) : null,
        position: { x: 0, y: 0 },
        outputArtifactMode: args.envelope.mode,
        outputWritePolicy: {
          persistenceMode: writePolicy.persistenceMode,
          baseDir: args.basedOn.workspaceBaseDir ?? writePolicy.baseDir ?? null,
          overwritePolicy: writePolicy.overwritePolicy,
        },
      },
      envelope: args.envelope,
      defaultBaseDir: args.basedOn.workspaceBaseDir ?? writePolicy.baseDir ?? null,
      metadata,
      contractValidation: args.contractValidation ?? null,
    });
  }

  approveArtifact(artifactId: string): Artifact | null {
    const artifact = this.deps.db.orchArtifacts.get(artifactId as any);
    if (!artifact) return null;
    if (artifact.workspaceStatus !== "staging") {
      this.deps.db.orchArtifacts.updateWorkspace(artifact.id, {
        status: "approved",
        workspaceStatus: artifact.workspaceStatus ?? "none",
      });
      return this.deps.db.orchArtifacts.get(artifact.id);
    }

    const fileEntries = this.deps.db.orchArtifactFiles.listByArtifact(artifact.id);
    if (!fileEntries.length) {
      this.deps.db.orchArtifacts.updateWorkspace(artifact.id, {
        status: "approved",
        workspaceStatus: "published",
        stagingPath: null,
        publishedPath: artifact.publishedPath ?? artifact.stagingPath ?? null,
      });
      return this.deps.db.orchArtifacts.get(artifact.id);
    }

    const updatedEntries = fileEntries.map((entry) => {
      return {
        id: entry.id,
        stagingPath: null,
        publishedPath: entry.publishedPath ?? normalizeRelPath(path.join(
          String(artifact.workspaceBaseDir ?? `codeflowai/artifacts/${artifact.instanceId}/${artifact.nodeId}`),
          entry.relPath,
        )),
        status: "published" as const,
      };
    });
    this.deps.db.orchArtifactFiles.updatePublishedPaths(artifact.id, updatedEntries);
    const publishedPath = updatedEntries.length === 1
      ? updatedEntries[0].publishedPath
      : normalizeRelPath(String(artifact.publishedPath ?? artifact.workspaceBaseDir ?? "")) || null;
    this.deps.db.orchArtifacts.updateWorkspace(artifact.id, {
      status: "approved",
      workspaceStatus: "published",
      stagingPath: null,
      publishedPath,
    });
    return this.deps.db.orchArtifacts.get(artifact.id);
  }

  discardArtifact(artifactId: string): Artifact | null {
    const artifact = this.deps.db.orchArtifacts.get(artifactId as any);
    if (!artifact) return null;
    this.deps.db.orchArtifactFiles.updateStatusByArtifact(artifact.id, "discarded");
    this.deps.db.orchArtifacts.updateWorkspace(artifact.id, {
      status: "rejected",
      workspaceStatus: artifact.workspaceStatus && artifact.workspaceStatus !== "none" ? "discarded" : artifact.workspaceStatus,
      publishedPath: artifact.publishedPath ?? artifact.stagingPath ?? null,
      stagingPath: null,
    });
    return this.deps.db.orchArtifacts.get(artifact.id);
  }

  /** 为 DB-only 主结果建立附件文件索引；不额外写出 result.md/result.json。 */
  private buildDbOnlyWorkspaceResult(args: {
    workspacePath: string;
    preferredBaseDir: string;
    envelope: NodeExecutionEnvelope;
    workspaceBackedPaths: Set<string>;
  }): WorkspaceWriteResult {
    const files = normalizeEnvelopeAttachmentFiles(args.envelope).map((file) => ({
      ...file,
      sourcePath: sanitizeArtifactRelPath(file.path),
      path: sanitizeArtifactRelPath(file.path),
    }));
    if (!files.length) {
      return {
        baseDir: args.preferredBaseDir,
        workspaceStatus: "none",
        stagingPath: null,
        publishedPath: null,
        fileEntries: [],
      };
    }
    assertUniqueArtifactPaths(files);
    const fileEntries = files.map((file) => {
      const payload = resolveWorkspaceFilePayload({
        workspacePath: args.workspacePath,
        sourcePath: file.sourcePath,
        content: args.workspaceBackedPaths.has(file.sourcePath) ? null : file.content ?? null,
      });
      return {
        relPath: file.path,
        stagingPath: null,
        publishedPath: file.path,
        status: "staging" as const,
        contentHash: hashBytes(payload.writeBuffer),
        sizeBytes: payload.writeBuffer.byteLength,
        actualContent: payload.isBinary ? null : decodeTextBuffer(payload.writeBuffer).content,
        actualBuffer: payload.writeBuffer,
      };
    });
    return {
      baseDir: resolveArtifactWorkspaceBaseDir(args.preferredBaseDir, fileEntries.map((entry) => entry.publishedPath ?? entry.relPath)),
      workspaceStatus: "staging",
      stagingPath: null,
      publishedPath: fileEntries.length === 1 ? fileEntries[0]?.publishedPath ?? null : null,
      fileEntries,
    };
  }

  private writeToWorkspace(args: {
    workspacePath: string;
    preferredBaseDir: string;
    envelope: NodeExecutionEnvelope;
    writePolicy: ResolvedWritePolicy;
    workspaceBackedPaths: Set<string>;
    allowRootedBaseDirOverride: boolean;
  }): WorkspaceWriteResult {
    const normalizedFiles = normalizeEnvelopeFiles(args.envelope).map((file) => ({
      ...file,
      sourcePath: sanitizeArtifactRelPath(file.path),
      path: sanitizeArtifactRelPath(file.path),
    }));
    const baseDir = resolveArtifactBaseDir({
      workspacePath: args.workspacePath,
      preferredBaseDir: args.preferredBaseDir,
      files: normalizedFiles,
      allowRootedBaseDirOverride: args.allowRootedBaseDirOverride,
    });
    const files = normalizedFiles.map((file) => ({
      ...file,
      sourcePath: file.sourcePath,
      path: normalizeArtifactOutputPath(args.workspacePath, baseDir, file.path),
    }));
    assertUniqueArtifactPaths(files);
    const fileEntries = files.map((file) => {
      const relPath = sanitizeArtifactRelPath(file.path);
      const existingPublishedPath = resolveExistingPublishedPath({
        workspacePath: this.deps.workspacePath,
        workspaceBackedPaths: args.workspaceBackedPaths,
        sourcePath: file.sourcePath,
        baseDir,
        relPath,
      });
      const publishedPath = existingPublishedPath
        ?? resolvePublishedPath({
          workspacePath: this.deps.workspacePath,
          baseDir,
          relPath,
          overwritePolicy: args.writePolicy.overwritePolicy,
        });
      const payload = resolveWorkspaceFilePayload({
        workspacePath: this.deps.workspacePath,
        sourcePath: file.sourcePath,
        content: args.workspaceBackedPaths.has(file.sourcePath) ? null : file.content ?? null,
      });
      const absPath = path.resolve(this.deps.workspacePath, publishedPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, payload.writeBuffer);
      const actualBuffer = fs.readFileSync(absPath);
      return {
        relPath,
        stagingPath: null,
        publishedPath,
        status: "staging" as const,
        contentHash: hashBytes(actualBuffer),
        sizeBytes: actualBuffer.byteLength,
        actualContent: payload.isBinary ? null : decodeTextBuffer(actualBuffer).content,
        actualBuffer,
      };
    });
    this.notifyWorkspaceFilesUpserted(fileEntries);
    const resolvedBaseDir = resolveArtifactWorkspaceBaseDir(baseDir, fileEntries.map((entry) => entry.publishedPath ?? entry.relPath));
    return {
      baseDir: resolvedBaseDir,
      workspaceStatus: "staging",
      stagingPath: null,
      publishedPath: fileEntries.length === 1
        ? fileEntries[0].publishedPath
        : normalizeRelPath(resolvedBaseDir) || null,
      fileEntries,
    };
  }

  /** 将产物写入的工作区文件同步到路径索引；缺少 workspace 上下文时不处理。 */
  private notifyWorkspaceFilesUpserted(fileEntries: WorkspaceFileEntrySnapshot[]): void {
    const workspaceId = this.deps.workspaceId;
    const workspacePathIndex = this.deps.workspacePathIndex;
    if (!workspaceId || !workspacePathIndex || fileEntries.length === 0) return;
    const changes = fileEntries
      .map((entry) => entry.publishedPath)
      .filter((relPath): relPath is string => typeof relPath === "string" && relPath.trim().length > 0)
      .map((relPath) => ({ type: "upsert" as const, path: relPath }));
    if (!changes.length) return;
    workspacePathIndex.applyChanges(workspaceId, this.deps.workspacePath, changes);
  }
}

export function validateArtifactWorkspaceOutput(args: {
  workspacePath: string;
  node: WorkflowNode;
  envelope: NodeExecutionEnvelope;
  defaultBaseDir?: string | null;
  /** 仅在角色交付路径规则已被平台完整解析时启用根目录守卫；未解析时保持既有校验行为。 */
  enableRootedPathGuard?: boolean;
}): {
  issues: ArtifactOutputPathValidationIssue[];
  expectedPaths: Array<{ returnedPath: string; expectedPath: string }>;
  resolvedBaseDir: string;
} {
  if (!args.workspacePath || (args.envelope.mode !== "file" && args.envelope.mode !== "file-set")) {
    return {
      issues: [],
      expectedPaths: [],
      resolvedBaseDir: normalizeRelPath(args.defaultBaseDir ?? ""),
    };
  }

  const writePolicy = resolveWritePolicy(args.node, args.envelope.mode);
  let configuredBaseDir = "";
  let preferredBaseDir = "";
  let normalizedFiles: Array<{ path: string; content: string | null; sourcePath: string }> = [];
  let baseDir = "";
  try {
    configuredBaseDir = sanitizeArtifactBaseDir(writePolicy.baseDir ?? "");
    preferredBaseDir = sanitizeArtifactBaseDir(
      configuredBaseDir || args.defaultBaseDir || `codeflowai/artifacts/validation/${args.node.id}`,
    );
    baseDir = preferredBaseDir;
    normalizedFiles = normalizeEnvelopeFiles(args.envelope).map((file) => ({
      ...file,
      sourcePath: sanitizeArtifactRelPath(file.path),
      path: sanitizeArtifactRelPath(file.path),
    }));
    baseDir = resolveArtifactBaseDir({
      workspacePath: args.workspacePath,
      preferredBaseDir,
      files: normalizedFiles,
      allowRootedBaseDirOverride: !configuredBaseDir && Boolean(args.defaultBaseDir),
    });
    const files = normalizedFiles.map((file) => ({
      ...file,
      path: normalizeArtifactOutputPath(args.workspacePath, baseDir, file.path),
    }));
    assertUniqueArtifactPaths(files);
    normalizedFiles = files;
    // 直接写在 workflowDocsRoot 根目录的路径丢掉了业务目录：显式失败并给出期望业务路径供模型重试。
    const rootedAtDocsRoot = args.enableRootedPathGuard
      ? normalizedFiles.filter((file) => isArtifactPathDirectlyUnderWorkflowDocsRoot(args.workspacePath, file.path))
      : [];
    if (rootedAtDocsRoot.length) {
      const expectedBaseDir = sanitizeArtifactBaseDir(args.defaultBaseDir ?? "");
      return {
        issues: rootedAtDocsRoot.map((file) => ({
          code: "ARTIFACT_PATH_RESOLUTION_MISMATCH",
          returnedPath: file.sourcePath,
          expectedPath: expectedBaseDir ? `${expectedBaseDir}/${path.posix.basename(file.path)}` : (args.defaultBaseDir ?? ""),
          message: `产物路径缺少业务目录：${file.sourcePath}。请按「路径规则」给出的完整业务路径提交`
            + (expectedBaseDir ? `；该类产物应落在 ${expectedBaseDir}/ 之下。` : "。"),
        })),
        expectedPaths: [],
        resolvedBaseDir: baseDir,
      };
    }
  } catch (error) {
    return {
      issues: [{
        code: "ARTIFACT_PATH_INVALID",
        returnedPath: extractFirstOutputPath(args.envelope),
        expectedPath: null,
        message: error instanceof Error ? error.message : "工件路径校验失败",
      }],
      expectedPaths: [],
      resolvedBaseDir: baseDir,
    };
  }

  const issues: ArtifactOutputPathValidationIssue[] = [];
  const expectedPaths: Array<{ returnedPath: string; expectedPath: string }> = [];

  for (const file of normalizedFiles) {
    const returnedPath = file.sourcePath;
    const relPath = sanitizeArtifactRelPath(file.path);
    const expectedPath = resolveWorkspaceOutputRelPath(args.workspacePath, baseDir, relPath);
    const expectedAbs = path.resolve(args.workspacePath, expectedPath);
    const returnedAbs = path.resolve(args.workspacePath, returnedPath);
    expectedPaths.push({ returnedPath, expectedPath });

    if (!workspacePathExists(expectedAbs)) {
      if (returnedPath !== expectedPath && workspacePathExists(returnedAbs)) {
        issues.push({
          code: "ARTIFACT_PATH_RESOLUTION_MISMATCH",
          returnedPath,
          expectedPath,
          message: `返回路径 ${returnedPath} 不会按该路径落地；平台会把它解析为 ${expectedPath}。请先把正式文件写到 ${expectedPath}，并在 runtime.submitNodeResult 的 answer 中返回这个路径。`,
        });
        continue;
      }
      issues.push({
        code: "ARTIFACT_FILE_MISSING",
        returnedPath,
        expectedPath,
        message: `工作区中找不到正式文件。返回路径：${returnedPath}；平台期望路径：${expectedPath}。请先把文件写到该目标路径，再返回 path/summary。`,
      });
      continue;
    }

    try {
      const stat = fs.statSync(expectedAbs);
      if (!stat.isFile()) {
        issues.push({
          code: "ARTIFACT_PATH_NOT_FILE",
          returnedPath,
          expectedPath,
          message: `目标路径不是文件：${expectedPath}。请返回正式文件路径，不要返回目录。`,
        });
      }
    } catch (error) {
      issues.push({
        code: "ARTIFACT_FILE_MISSING",
        returnedPath,
        expectedPath,
        message: error instanceof Error ? error.message : `工件文件不存在：${expectedPath}`,
      });
    }
  }

  return {
    issues,
    expectedPaths,
    resolvedBaseDir: baseDir,
  };
}

type ResolvedWritePolicy = {
  persistenceMode: ArtifactPersistenceMode;
  baseDir: string | null;
  overwritePolicy: NonNullable<OutputWritePolicy["overwritePolicy"]>;
};

function resolveWritePolicy(node: WorkflowNode, outputMode: ArtifactOutputMode): ResolvedWritePolicy {
  const configured = node.outputWritePolicy ?? null;
  if (configured) {
    return {
      persistenceMode: configured.persistenceMode ?? defaultPersistenceMode(outputMode),
      baseDir: configured.baseDir ?? null,
      overwritePolicy: configured.overwritePolicy ?? "create-versioned-copy",
    };
  }
  return {
    persistenceMode: defaultPersistenceMode(outputMode),
    baseDir: null,
    overwritePolicy: "create-versioned-copy",
  };
}

function defaultPersistenceMode(outputMode: ArtifactOutputMode): ArtifactPersistenceMode {
  return outputMode === "file" || outputMode === "file-set" ? "dual-write" : "db-only";
}

/** 按文件顺序提取节点结果契约元数据；持久化文件顺序与提交 answer 文件顺序一致。 */
function resolveFileContractMetadata(
  validation: NodeResultContractValidationResult | null | undefined,
  envelope: NodeExecutionEnvelope,
  index: number,
): {
  fileKey: string | null;
  fileRole: "contract" | "attachment";
  format: string | null;
  contractKey: string | null;
  validationStatus: "not_validated" | "valid" | "invalid" | "warning" | null;
  summary: string | null;
} | null {
  const file = validation?.normalizedFiles?.[index] ?? resolveEnvelopeFileMetadata(envelope, index);
  if (!file) return null;
  const result = validation?.fileResults?.find((item) =>
    String(item.fileKey ?? "") === String(file.fileKey ?? "")
      && String(item.path ?? "") === String(file.relPath ?? ""),
  ) ?? validation?.fileResults?.[index] ?? null;
  return {
    fileKey: file.fileKey ?? null,
    fileRole: file.source === "attachment" ? "attachment" : "contract",
    format: file.source === "attachment" ? file.kind ?? file.format ?? null : file.format ?? null,
    contractKey: file.contractKey ?? (file.source === "attachment" ? null : file.fileKey ?? null),
    validationStatus: result?.status ?? null,
    summary: file.summary ?? null,
  };
}

/** 合并人工修订元数据，但不继承仅属于模型节点 Attempt 的幂等标识。 */
function buildHumanRevisionMetadata(
  basedOnMetadata: ArtifactMetadata | null | undefined,
  additionalMetadata: ArtifactMetadata | null | undefined,
  revision: ArtifactRevisionMetadata,
): ArtifactMetadata {
  const {
    nodeAttemptId: _nodeAttemptId,
    ...metadata
  } = {
    ...(basedOnMetadata ?? {}),
    ...(additionalMetadata ?? {}),
    revision,
  };
  return metadata;
}

function resolvePersistedWritePolicy(
  artifact: Artifact,
  outputMode: ArtifactOutputMode = artifact.payloadMode ?? "text",
): ResolvedWritePolicy {
  const persisted = getArtifactWritePolicyFromMetadata(artifact);
  return {
    persistenceMode: artifact.persistenceMode ?? persisted?.persistenceMode ?? defaultPersistenceMode(outputMode),
    baseDir: artifact.workspaceBaseDir ?? persisted?.baseDir ?? null,
    overwritePolicy: normalizeOverwritePolicy(persisted?.overwritePolicy),
  };
}

function normalizeEnvelopeFiles(envelope: NodeExecutionEnvelope): NormalizedEnvelopeFile[] {
  const attachments = (envelope.attachments ?? []).map((file) => ({ path: file.path, content: file.content ?? null }));
  switch (envelope.mode) {
    case "text":
      return [{ path: "result.md", content: envelope.text }, ...attachments];
    case "structured":
      return [{ path: "result.json", content: JSON.stringify(envelope.data, null, 2) }, ...attachments];
    case "file":
      return [{ path: envelope.file.path, content: envelope.file.content ?? null }, ...attachments];
    case "file-set":
      return [
        ...envelope.files.map((file) => ({ path: file.path, content: file.content ?? null })),
        ...attachments,
      ];
  }
}

/** 提取动态附件路径，供 DB-only 主结果建立可下游引用的附件索引。 */
function normalizeEnvelopeAttachmentFiles(envelope: NodeExecutionEnvelope): NormalizedEnvelopeFile[] {
  return (envelope.attachments ?? []).map((file) => ({
    path: file.path,
    content: file.content ?? null,
  }));
}

/** 当运行时没有契约校验结果时，按 envelope 顺序保留正式交付物与附件身份。 */
function resolveEnvelopeFileMetadata(envelope: NodeExecutionEnvelope, index: number): {
  fileKey: string | null;
  relPath: string;
  source?: "contract" | "attachment";
  contractKey?: string | null;
  summary?: string | null;
  kind?: AttachmentKind | null;
  format?: string | null;
} | null {
  if (envelope.mode === "file") {
    if (index === 0) {
      return {
        fileKey: envelope.file.key ?? null,
        relPath: envelope.file.path,
        source: "contract",
        contractKey: envelope.file.key ?? null,
        summary: envelope.file.summary ?? null,
        format: null,
      };
    }
    const attachment = envelope.attachments?.[index - 1] ?? null;
    return attachment ? toAttachmentMetadata(attachment) : null;
  }
  if (envelope.mode === "file-set") {
    if (index < envelope.files.length) {
      const file = envelope.files[index];
      return {
        fileKey: file.key ?? null,
        relPath: file.path,
        source: "contract",
        contractKey: file.key ?? null,
        summary: file.summary ?? null,
        format: null,
      };
    }
    const attachment = envelope.attachments?.[index - envelope.files.length] ?? null;
    return attachment ? toAttachmentMetadata(attachment) : null;
  }
  const attachment = envelope.attachments?.[index] ?? null;
  return attachment ? toAttachmentMetadata(attachment) : null;
}

/** 将动态附件转成文件索引元数据，路径用于和校验结果对齐。 */
function toAttachmentMetadata(file: NonNullable<NodeExecutionEnvelope["attachments"]>[number]): {
  fileKey: string | null;
  relPath: string;
  source: "attachment";
  contractKey: null;
  summary: string | null;
  kind: AttachmentKind | null;
  format: string | null;
} {
  return {
    fileKey: file.key ?? null,
    relPath: file.path,
    source: "attachment",
    contractKey: null,
    summary: file.summary ?? null,
    kind: file.kind ?? null,
    format: file.format ?? null,
  };
}

function buildPersistedEnvelope(
  envelope: NodeExecutionEnvelope,
  fileEntries: WorkspaceFileEntrySnapshot[],
): NodeExecutionEnvelope {
  if (envelope.mode === "text") {
    return {
      ...envelope,
      attachments: materializeAttachmentContent(envelope.attachments, fileEntries, 1),
    };
  }
  if (envelope.mode === "structured") {
    return {
      ...envelope,
      attachments: materializeAttachmentContent(envelope.attachments, fileEntries, 1),
    };
  }
  if (envelope.mode === "file") {
    const attachmentOffset = 1;
    return {
      ...envelope,
      file: {
        ...envelope.file,
        content: fileEntries[0]?.actualContent ?? envelope.file.content ?? null,
      },
      attachments: materializeAttachmentContent(envelope.attachments, fileEntries, attachmentOffset),
    };
  }
  if (envelope.mode === "file-set") {
    const attachmentOffset = envelope.files.length;
    return {
      ...envelope,
      files: envelope.files.map((file, index) => ({
        ...file,
        content: fileEntries[index]?.actualContent ?? file.content ?? null,
      })),
      attachments: materializeAttachmentContent(envelope.attachments, fileEntries, attachmentOffset),
    };
  }
  return envelope;
}

function materializeEnvelopeForPersistence(envelope: NodeExecutionEnvelope, workspacePath: string): NodeExecutionEnvelope {
  if (envelope.mode === "text" || envelope.mode === "structured") {
    return {
      ...envelope,
      attachments: materializeAttachmentsForPersistence(envelope.attachments, workspacePath),
    };
  }
  if (envelope.mode === "file") {
    return {
      ...envelope,
      file: {
        ...envelope.file,
        content: resolveEnvelopeFileContentForPersistence(envelope.file, workspacePath),
      },
      attachments: materializeAttachmentsForPersistence(envelope.attachments, workspacePath),
    };
  }
  if (envelope.mode === "file-set") {
    return {
      ...envelope,
      files: envelope.files.map((file) => ({
        ...file,
        content: resolveEnvelopeFileContentForPersistence(file, workspacePath),
      })),
      attachments: materializeAttachmentsForPersistence(envelope.attachments, workspacePath),
    };
  }
  return envelope;
}

/** 将附件正文按文件快照顺序写回 envelope，保持正式交付物与附件分离。 */
function materializeAttachmentContent(
  attachments: NodeExecutionEnvelope["attachments"],
  fileEntries: WorkspaceFileEntrySnapshot[],
  offset: number,
): NodeExecutionEnvelope["attachments"] {
  if (!attachments?.length) return attachments ?? null;
  return attachments.map((file, index) => ({
    ...file,
    content: fileEntries[offset + index]?.actualContent ?? file.content ?? null,
  }));
}

/** 读取附件正文；附件和正式交付物使用同一套工作区读取规则。 */
function materializeAttachmentsForPersistence(
  attachments: NodeExecutionEnvelope["attachments"],
  workspacePath: string,
): NodeExecutionEnvelope["attachments"] {
  if (!attachments?.length) return attachments ?? null;
  return attachments.map((file) => ({
    ...file,
    content: resolveEnvelopeFileContentForPersistence(file, workspacePath),
  }));
}

/** 读取工件文件正文；显式 content 原样保留，工作区文本兼容 UTF-8/GB18030。 */
function resolveEnvelopeFileContentForPersistence(file: { path: string; content?: string | null }, workspacePath: string): string | null {
  if (Object.prototype.hasOwnProperty.call(file, "content") && typeof file.content === "string") {
    return file.content;
  }
  const relPath = sanitizeArtifactRelPath(file.path);
  if (!workspacePath) {
    throw new Error(`工件文件缺少正文且无法读取工作区：${relPath}`);
  }
  const absPath = path.resolve(workspacePath, relPath);
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`工件路径不是文件：${relPath}`);
    }
    if (isBinaryFile(relPath)) {
      return null;
    }
    return decodeTextBuffer(fs.readFileSync(absPath)).content;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    throw new Error(`工件文件不存在或不可读：${relPath}（${reason}）`);
  }
}

function collectWorkspaceBackedPaths(envelope: NodeExecutionEnvelope): Set<string> {
  const set = new Set<string>();
  if (envelope.mode === "file") {
    if (!Object.prototype.hasOwnProperty.call(envelope.file, "content")) {
      set.add(sanitizeArtifactRelPath(envelope.file.path));
    }
  } else if (envelope.mode === "file-set") {
    for (const file of envelope.files) {
      if (!Object.prototype.hasOwnProperty.call(file, "content")) {
        set.add(sanitizeArtifactRelPath(file.path));
      }
    }
  }
  for (const file of envelope.attachments ?? []) {
    if (!Object.prototype.hasOwnProperty.call(file, "content")) {
      set.add(sanitizeArtifactRelPath(file.path));
    }
  }
  return set;
}

function normalizeArtifactOutputPath(workspacePath: string, baseDir: string, filePath: string): string {
  const normalizedBaseDir = sanitizeArtifactBaseDir(baseDir);
  const normalizedPath = sanitizeArtifactRelPath(filePath);
  if (workspacePath && isWorkspaceRootedArtifactPath(workspacePath, normalizedPath)) {
    return normalizedPath;
  }
  if (!normalizedBaseDir) return normalizedPath;
  if (normalizedPath === normalizedBaseDir) return normalizedPath;
  if (!normalizedPath.startsWith(`${normalizedBaseDir}/`)) return normalizedPath;
  const stripped = normalizedPath.slice(normalizedBaseDir.length + 1);
  return stripped || normalizedPath;
}

function resolveArtifactBaseDir(input: {
  workspacePath: string;
  preferredBaseDir: string;
  files: Array<{ path: string; content: string | null }>;
  allowRootedBaseDirOverride: boolean;
}): string {
  const preferredBaseDir = sanitizeArtifactBaseDir(input.preferredBaseDir);
  if (!input.allowRootedBaseDirOverride || !preferredBaseDir || !input.files.length) {
    return preferredBaseDir;
  }
  const workflowDocsRoot = readConfiguredWorkflowDocsRoot(input.workspacePath);
  if (!isSameOrNestedPath(preferredBaseDir, workflowDocsRoot)) {
    return preferredBaseDir;
  }
  const normalizedPaths = input.files.map((file) => sanitizeArtifactRelPath(file.path));
  if (!normalizedPaths.every((filePath) => isSameOrNestedPath(filePath, workflowDocsRoot))) {
    return preferredBaseDir;
  }
  if (normalizedPaths.every((filePath) => filePath === preferredBaseDir || filePath.startsWith(`${preferredBaseDir}/`))) {
    return preferredBaseDir;
  }
  const commonDir = findCommonParentDir(normalizedPaths);
  if (!commonDir) return preferredBaseDir;
  // 如果模型已经返回了带业务根目录的工作区相对路径（例如 `codeflow-docs/...`），
  // 就直接沿用这个根，不要再额外套一层更深的默认目录。
  return commonDir;
}

/**
 * 判断产物路径是否直接挂在 workflowDocsRoot 根目录下。
 * 这类路径丢掉了业务目录信息（例如 codeflow-docs/dev-review.md），平台必须拒绝而不是照单落盘。
 */
function isArtifactPathDirectlyUnderWorkflowDocsRoot(workspacePath: string, filePath: string): boolean {
  const workflowDocsRoot = sanitizeArtifactBaseDir(readConfiguredWorkflowDocsRoot(workspacePath));
  if (!workflowDocsRoot) return false;
  let normalizedPath = "";
  try {
    normalizedPath = sanitizeArtifactRelPath(filePath);
  } catch {
    return false;
  }
  return path.posix.dirname(normalizedPath) === workflowDocsRoot;
}

function isWorkspaceRootedArtifactPath(workspacePath: string, filePath: string): boolean {
  const normalizedPath = sanitizeArtifactRelPath(filePath);
  if (isConfiguredWorkspaceRoot(workspacePath, normalizedPath)) return true;
  const configuredWorkflowDocsRoot = readConfiguredWorkflowDocsRoot(workspacePath);
  const rootSegment = firstPathSegment(normalizedPath);
  const configuredRootSegment = firstPathSegment(configuredWorkflowDocsRoot);
  if (rootSegment && rootSegment !== configuredRootSegment) {
    const candidateRoot = path.resolve(workspacePath, rootSegment);
    if (workspacePathExists(candidateRoot)) return true;
  }
  const normalizedDir = path.posix.dirname(normalizedPath);
  if (!normalizedDir || normalizedDir === ".") {
    return workspacePathExists(path.resolve(workspacePath, normalizedPath));
  }
  const candidateDir = path.resolve(workspacePath, normalizedDir);
  return workspacePathExists(candidateDir);
}

function sanitizeArtifactRelPath(filePath: string): string {
  const rawPath = typeof filePath === "string" ? filePath : "";
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith("\\\\")) {
    throw new Error(`工件路径非法：${filePath}`);
  }
  const normalized = normalizeRelPath(rawPath);
  if (!normalized || normalized.startsWith("..")) {
    throw new Error(`工件路径非法：${filePath}`);
  }
  validateArtifactRelPathSegments(normalized, filePath);
  return normalized;
}

/** Validates optional artifact base directories with the same segment policy as returned files. */
function sanitizeArtifactBaseDir(baseDir: string | null | undefined): string {
  const rawBaseDir = String(baseDir ?? "");
  if (!rawBaseDir) return "";
  if (path.isAbsolute(rawBaseDir) || /^[a-zA-Z]:/.test(rawBaseDir) || rawBaseDir.startsWith("\\\\")) {
    throw new Error(`工件路径非法：${baseDir}`);
  }
  const normalized = normalizeRelPath(rawBaseDir).replace(/\/+$/g, "");
  if (!normalized) return "";
  validateArtifactRelPathSegments(normalized, rawBaseDir);
  return normalized;
}

/** Validates every returned path segment before any workspace write occurs. */
function validateArtifactRelPathSegments(normalizedPath: string, originalPath: string): void {
  for (const segment of normalizedPath.split("/")) {
    validateArtifactPathSegment(segment, originalPath);
  }
}

/** Rejects file-system-incompatible segment names instead of silently rewriting model output. */
function validateArtifactPathSegment(segment: string, originalPath: string): void {
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`工件路径非法：${originalPath}。路径不能包含空目录段、"." 或 ".."。`);
  }
  if (WINDOWS_INVALID_PATH_SEGMENT_CHAR_RE.test(segment)) {
    throw new Error(`工件路径非法：${originalPath}。路径段 "${segment}" 包含文件系统不兼容字符，请使用 task_title_path_segment 生成目录或文件名。`);
  }
  if (/[. ]$/.test(segment)) {
    throw new Error(`工件路径非法：${originalPath}。路径段 "${segment}" 不能以空格或点结尾。`);
  }
  if (WINDOWS_RESERVED_PATH_SEGMENT_RE.test(segment)) {
    throw new Error(`工件路径非法：${originalPath}。路径段 "${segment}" 是 Windows 保留名称，请使用 task_title_path_segment 生成目录或文件名。`);
  }
  if (Array.from(segment).length > MAX_ARTIFACT_PATH_SEGMENT_LENGTH) {
    throw new Error(`工件路径非法：${originalPath}。路径段 "${segment}" 超过 ${MAX_ARTIFACT_PATH_SEGMENT_LENGTH} 个字符，请缩短目录或文件名。`);
  }
  if (Buffer.byteLength(segment, "utf8") > MAX_ARTIFACT_PATH_SEGMENT_BYTES) {
    throw new Error(`工件路径非法：${originalPath}。路径段 "${segment}" 超过 ${MAX_ARTIFACT_PATH_SEGMENT_BYTES} 字节，请缩短目录或文件名。`);
  }
}

function assertUniqueArtifactPaths(files: Array<{ path: string; content: string | null }>): void {
  const seen = new Set<string>();
  const seenPortable = new Map<string, string>();
  for (const file of files) {
    const relPath = sanitizeArtifactRelPath(file.path);
    if (seen.has(relPath)) {
      throw new Error(`工件输出包含重复路径：${relPath}`);
    }
    const portableKey = relPath.toLowerCase();
    const existingPath = seenPortable.get(portableKey);
    if (existingPath && existingPath !== relPath) {
      throw new Error(`工件输出包含大小写冲突路径：${existingPath} 与 ${relPath}`);
    }
    seen.add(relPath);
    seenPortable.set(portableKey, relPath);
  }
}

function resolvePublishedPath(input: {
  workspacePath: string;
  baseDir: string;
  relPath: string;
  overwritePolicy: NonNullable<OutputWritePolicy["overwritePolicy"]>;
}): string {
  const desiredRelPath = sanitizeArtifactRelPath(input.relPath);
  const targetRelPath = resolveWorkspaceOutputRelPath(input.workspacePath, input.baseDir, desiredRelPath);
  const targetAbs = path.resolve(input.workspacePath, targetRelPath);
  if (input.overwritePolicy === "overwrite") {
    return targetRelPath;
  }
  if (input.overwritePolicy === "reject") {
    if (workspacePathExists(targetAbs)) {
      throw new Error(`工件发布失败，目标已存在：${desiredRelPath}`);
    }
    return targetRelPath;
  }
  // 保持工作区业务目录只有一份正式文件；历史版本由 DB/Artifact 记录承载。
  return targetRelPath;
}

function resolveExistingPublishedPath(input: {
  workspacePath: string;
  workspaceBackedPaths: Set<string>;
  sourcePath: string;
  baseDir: string;
  relPath: string;
}): string | null {
  const normalizedSourcePath = sanitizeArtifactRelPath(input.sourcePath);
  if (!input.workspaceBackedPaths.has(normalizedSourcePath)) return null;
  const expectedPath = resolveWorkspaceOutputRelPath(input.workspacePath, input.baseDir, input.relPath);
  if (!normalizedSourcePath || normalizedSourcePath !== expectedPath) return null;
  // 优先 workspace 根目录，回退到唯一项目子目录
  if (workspacePathExists(path.resolve(input.workspacePath, normalizedSourcePath))) {
    return normalizedSourcePath;
  }
  const projectDirs = discoverWorkspaceProjectDirs(input.workspacePath);
  const candidates = projectDirs
    .map((projDir) => path.resolve(projDir, normalizedSourcePath))
    .filter((p) => workspacePathExists(p));
  if (candidates.length === 1) {
    return path.relative(input.workspacePath, candidates[0]);
  }
  return null;
}

function extractFirstOutputPath(envelope: NodeExecutionEnvelope): string {
  if (envelope.mode === "file") return String(envelope.file.path ?? "").trim();
  if (envelope.mode === "file-set") return String(envelope.files[0]?.path ?? "").trim();
  return "";
}

function normalizeOverwritePolicy(value: unknown): NonNullable<OutputWritePolicy["overwritePolicy"]> {
  const text = String(value ?? "").trim();
  if (text === "reject" || text === "overwrite") return text;
  return "create-versioned-copy";
}

function workspacePathExists(absPath: string): boolean {
  try {
    fs.accessSync(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function findCommonParentDir(paths: string[]): string {
  const parentSegments = paths
    .map((filePath) => path.posix.dirname(sanitizeArtifactRelPath(filePath)))
    .map((dirPath) => dirPath.split("/").filter(Boolean));
  if (!parentSegments.length) return "";
  const common: string[] = [];
  const first = parentSegments[0];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (!segment) break;
    if (!parentSegments.every((parts) => parts[index] === segment)) break;
    common.push(segment);
  }
  return common.join("/");
}

function isConfiguredWorkspaceRoot(workspacePath: string, filePath: string): boolean {
  const normalizedPath = normalizeRelPath(filePath);
  if (!workspacePath || !normalizedPath) return false;
  try {
    const workflowDocsRoot = readConfiguredWorkflowDocsRoot(workspacePath);
    return isSameOrNestedPath(normalizedPath, workflowDocsRoot);
  } catch {
    return false;
  }
}

function firstPathSegment(filePath: string): string {
  return normalizeRelPath(filePath).split("/").filter(Boolean)[0] ?? "";
}

function readConfiguredWorkflowDocsRoot(workspacePath: string): string {
  try {
    const existing = readExistingCodeflowaiConfig(workspacePath);
    return normalizeRelPath(String(existing?.config.paths?.workflowDocsRoot ?? "").trim() || "codeflow-docs");
  } catch {
    return "codeflow-docs";
  }
}

function isSameOrNestedPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeRelPath(candidate);
  const normalizedRoot = normalizeRelPath(root);
  if (!normalizedCandidate || !normalizedRoot) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/** 扫描 workspace 下含 `codeflowai/codeflowai.json` 的一级子目录，供文件路径回退发现。 */
function discoverWorkspaceProjectDirs(workspacePath: string): string[] {
  const abs = path.resolve(String(workspacePath ?? "").trim());
  if (!abs || !fs.existsSync(abs)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(abs, e.name))
    .filter((projectPath) => {
      try {
        return readExistingCodeflowaiConfig(projectPath) !== null;
      } catch {
        return false;
      }
    });
}

/** 在工作区根目录及项目子目录中查找工件文件；优先根目录，回退到唯一项目子目录。 */
function resolveWorkspaceFileAbsPath(workspacePath: string, relPath: string): string {
  const primaryAbs = path.resolve(workspacePath, relPath);
  if (fs.existsSync(primaryAbs)) return primaryAbs;

  const projectDirs = discoverWorkspaceProjectDirs(workspacePath);
  const candidates = projectDirs
    .map((projDir) => path.resolve(projDir, relPath))
    .filter((p) => fs.existsSync(p));

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `工件文件路径不明确，在多个项目目录中找到：${relPath}（候选：${candidates.join(", ")}）`,
    );
  }
  return primaryAbs;
}

/** 生成工作区写入 payload；已有文件使用原始字节，避免转换时破坏原编码。 */
function resolveWorkspaceFilePayload(input: {
  workspacePath: string;
  sourcePath: string;
  content: string | null;
}): { writeBuffer: Buffer; isBinary: boolean } {
  if (typeof input.content === "string") {
    return {
      writeBuffer: Buffer.from(input.content, "utf8"),
      isBinary: false,
    };
  }

  const relPath = sanitizeArtifactRelPath(input.sourcePath);
  if (!input.workspacePath) {
    throw new Error(`工件文件缺少正文且无法读取工作区：${relPath}`);
  }

  const absPath = resolveWorkspaceFileAbsPath(input.workspacePath, relPath);
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`工件路径不是文件：${relPath}`);
    }
    if (isBinaryFile(relPath)) {
      return {
        writeBuffer: fs.readFileSync(absPath),
        isBinary: true,
      };
    }
    return {
      writeBuffer: fs.readFileSync(absPath),
      isBinary: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    throw new Error(`工件文件不存在或不可读：${relPath}（${reason}）`);
  }
}

function resolveArtifactWorkspaceBaseDir(baseDir: string, publishedPaths: string[]): string {
  const normalizedBaseDir = sanitizeArtifactBaseDir(baseDir);
  const normalizedPaths = publishedPaths
    .map((item) => normalizeRelPath(item))
    .filter(Boolean);
  if (!normalizedPaths.length) return normalizedBaseDir;
  if (normalizedBaseDir && normalizedPaths.every((item) => item === normalizedBaseDir || item.startsWith(`${normalizedBaseDir}/`))) {
    return normalizedBaseDir;
  }
  const commonDir = findCommonParentDir(normalizedPaths);
  if (!commonDir) {
    return "";
  }
  return commonDir;
}

function resolveWorkspaceOutputRelPath(workspacePath: string, baseDir: string, relPath: string): string {
  const normalizedBaseDir = sanitizeArtifactBaseDir(baseDir);
  const normalizedRelPath = sanitizeArtifactRelPath(relPath);
  if (!normalizedBaseDir) return normalizedRelPath;
  if (normalizedRelPath === normalizedBaseDir || normalizedRelPath.startsWith(`${normalizedBaseDir}/`)) {
    return normalizedRelPath;
  }
  if (workspacePath && isWorkspaceRootedArtifactPath(workspacePath, normalizedRelPath)) {
    return normalizedRelPath;
  }
  return normalizeRelPath(path.join(normalizedBaseDir, normalizedRelPath));
}

function normalizeRelPath(filePath: string): string {
  return String(filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function extractEnvelopeSummary(envelope: NodeExecutionEnvelope): string | null {
  if ("summary" in envelope && envelope.summary) return envelope.summary;
  if (envelope.mode === "text") return envelope.text.slice(0, 200);
  if (envelope.mode === "structured") return JSON.stringify(envelope.data).slice(0, 200);
  if (envelope.mode === "file") return envelope.file.summary ?? envelope.file.path;
  return envelope.files.map((file) => file.summary ?? file.path).join(", ");
}

function extractChangedFiles(envelope: NodeExecutionEnvelope): string[] | null {
  return "changedFiles" in envelope && Array.isArray(envelope.changedFiles)
    ? envelope.changedFiles.map((item) => String(item ?? "").trim()).filter(Boolean)
    : null;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function hashBytes(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

