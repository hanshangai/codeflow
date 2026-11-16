import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  InlineKnowledgeItem,
  KnowledgeBundleDefinition,
  KnowledgeCatalogSnapshot,
  KnowledgeResolverWarning,
  RuntimeKnowledgeSource,
} from "@codeflowai/shared";

import { ensureCodeflowaiConfig, resolveWorkflowDocsRoot } from "../codeflowai/codeflowaiConfig.js";
import { resolveWorkspacePath } from "../fs/fsHelpers.js";

const INLINE_BODY_MAX_CHARS = 6_000;
const INLINE_PROMPT_TOTAL_MAX_CHARS = 12_000;

export class KnowledgeRuntimeService {
  constructor(private readonly workspacePath: string) {}

  buildCatalog(bundle: KnowledgeBundleDefinition): KnowledgeCatalogSnapshot {
    const warnings: KnowledgeResolverWarning[] = [];
    const inlineItems: InlineKnowledgeItem[] = [];
    const runtimeSources: RuntimeKnowledgeSource[] = [];

    for (const source of bundle.sourceRefs.filter((item) => item.enabled !== false)) {
      const sourceKey = buildSourceKey(bundle.id, source.id);
      switch (source.kind) {
        case "manual-text":
        case "inline-doc": {
          const body = String(source.inlineBody ?? "").trim();
          if (!body) {
            warnings.push(makeWarning(bundle.id, source.id, "SOURCE_EMPTY", "正文内容为空"));
            continue;
          }
          const truncated = body.length > INLINE_BODY_MAX_CHARS;
          const bodyText = truncated ? `${body.slice(0, INLINE_BODY_MAX_CHARS)}\n\n...(已截断)` : body;
          inlineItems.push({
            bundleId: bundle.id,
            bundleName: bundle.name,
            sourceId: source.id,
            sourceKey,
            sourceKind: source.kind,
            title: source.title,
            description: source.description ?? null,
            bodyText,
            injectedAt: Date.now(),
            contentHash: hashText(bodyText),
            truncated,
          });
          break;
        }
        case "workspace-file":
        case "workspace-dir": {
          const normalizedRef = normalizeWorkspaceRef(source.ref, source.kind === "workspace-dir");
          if (normalizedRef == null) {
            warnings.push(makeWarning(bundle.id, source.id, "SOURCE_EMPTY", "项目路径不能为空"));
            continue;
          }
          let workspaceRelPath = "";
          let absPath = "";
          try {
            workspaceRelPath = normalizeWorkspaceRelPath(this.workspacePath, normalizedRef);
            absPath = resolveWorkspacePath(this.workspacePath, workspaceRelPath);
          } catch (error) {
            warnings.push(makeWarning(
              bundle.id,
              source.id,
              "SOURCE_PATH_INVALID",
              error instanceof Error ? error.message : `非法项目路径：${normalizedRef}`,
            ));
            continue;
          }
          const targetType = source.kind === "workspace-dir" ? "directory" : "file";
          if (!validatePathType(absPath, targetType)) {
            warnings.push(makeWarning(
              bundle.id,
              source.id,
              "SOURCE_NOT_FOUND",
              `${targetType === "directory" ? "目录" : "文件"}不存在：${normalizedRef || "."}`,
            ));
            continue;
          }
          runtimeSources.push({
            bundleId: bundle.id,
            bundleName: bundle.name,
            sourceId: source.id,
            sourceKey,
            sourceKind: source.kind,
            title: source.title,
            description: source.description ?? null,
            originRef: normalizedRef || ".",
            workspaceRelPath,
            targetType,
          });
          break;
        }
        case "workbench-doc":
        case "workbench-dir": {
          const docsRootAbs = resolveWorkflowDocsRoot(this.workspacePath, ensureCodeflowaiConfig(this.workspacePath).config);
          const normalizedRef = normalizeWorkbenchRef(source.ref, source.kind === "workbench-dir");
          if (normalizedRef == null) {
            warnings.push(makeWarning(bundle.id, source.id, "SOURCE_EMPTY", "工作台路径不能为空"));
            continue;
          }
          let absPath = "";
          try {
            absPath = resolveChildPath(docsRootAbs, normalizedRef);
          } catch (error) {
            warnings.push(makeWarning(
              bundle.id,
              source.id,
              "SOURCE_PATH_INVALID",
              error instanceof Error ? error.message : `非法工作台路径：${normalizedRef}`,
            ));
            continue;
          }
          const targetType = source.kind === "workbench-dir" ? "directory" : "file";
          if (!validatePathType(absPath, targetType)) {
            warnings.push(makeWarning(
              bundle.id,
              source.id,
              "SOURCE_NOT_FOUND",
              `${targetType === "directory" ? "工作台目录" : "工作台文档"}不存在：${normalizedRef || "."}`,
            ));
            continue;
          }
          runtimeSources.push({
            bundleId: bundle.id,
            bundleName: bundle.name,
            sourceId: source.id,
            sourceKey,
            sourceKind: source.kind,
            title: source.title,
            description: source.description ?? null,
            originRef: normalizedRef || ".",
            workspaceRelPath: normalizeRelPath(path.relative(this.workspacePath, absPath)),
            targetType,
          });
          break;
        }
        default:
          warnings.push(makeWarning(bundle.id, source.id, "SOURCE_UNSUPPORTED", `暂不支持的知识来源类型：${source.kind}`));
      }
    }

    return {
      bundleId: bundle.id,
      bundleName: bundle.name,
      scope: bundle.scope,
      createdAt: Date.now(),
      inlineItems,
      runtimeSources,
      warnings,
    };
  }

  trimInlineItemsForPrompt(items: InlineKnowledgeItem[]): InlineKnowledgeItem[] {
    const selected: InlineKnowledgeItem[] = [];
    let totalChars = 0;
    for (const item of items) {
      if (totalChars >= INLINE_PROMPT_TOTAL_MAX_CHARS) break;
      const remaining = INLINE_PROMPT_TOTAL_MAX_CHARS - totalChars;
      if (remaining <= 0) break;
      const body = String(item.bodyText ?? "");
      if (!body) continue;
      const finalBody = body.length > remaining ? `${body.slice(0, remaining)}\n\n...(已截断)` : body;
      selected.push({
        ...item,
        bodyText: finalBody,
        truncated: item.truncated || finalBody.length < body.length,
        contentHash: hashText(finalBody),
      });
      totalChars += finalBody.length;
    }
    return selected;
  }
}

export function buildSourceKey(bundleId: string, sourceId: string): string {
  return `${bundleId}:${sourceId}`;
}

function makeWarning(bundleId: string, sourceId: string, code: string, message: string): KnowledgeResolverWarning {
  return {
    bundleId: bundleId as any,
    sourceId,
    code,
    message,
  };
}

function normalizeWorkspaceRef(raw: string | null | undefined, isDir: boolean): string | null {
  const value = String(raw ?? "").trim();
  if (value) return normalizeRelPath(value);
  return isDir ? "." : null;
}

function normalizeWorkbenchRef(raw: string | null | undefined, isDir: boolean): string | null {
  const value = String(raw ?? "").trim();
  if (value) return normalizeRelPath(value);
  return isDir ? "." : null;
}

function normalizeWorkspaceRelPath(workspacePath: string, ref: string): string {
  const normalized = ref === "." ? "" : normalizeRelPath(ref);
  resolveWorkspacePath(workspacePath, normalized);
  return normalized;
}

function resolveChildPath(rootPath: string, relPath: string): string {
  const normalized = relPath === "." ? "" : normalizeRelPath(relPath);
  const absPath = path.resolve(rootPath, normalized);
  const relative = path.relative(path.resolve(rootPath), absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径越界：${relPath}`);
  }
  return absPath;
}

function validatePathType(absPath: string, targetType: "file" | "directory"): boolean {
  try {
    const stat = fs.statSync(absPath);
    return targetType === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function normalizeRelPath(filePath: string): string {
  const normalized = String(filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

