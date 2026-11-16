import {
  getTaskIntakeTitle,
  type RoleDefinition,
  type TaskIntake,
  type WorkflowNode,
  type WorkflowRuntimeDefinition,
} from "@codeflowai/shared";

import { ensureCodeflowaiConfig } from "../codeflowai/codeflowaiConfig.js";

const DEFAULT_FEATURE_ROOT_DIR = "功能";
const DEFAULT_WORKFLOW_DOCS_ROOT = "codeflow-docs";
const WINDOWS_RESERVED_PATH_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Builds the fallback artifact directory when a role does not return a rooted file path. */
export function buildDefaultArtifactBaseDir(input: {
  workspacePath: string;
  intake: TaskIntake;
  workflow: WorkflowRuntimeDefinition;
  node: WorkflowNode;
  role: RoleDefinition;
}): string {
  const workflowDocsRoot = normalizeRelPath(
    String(ensureCodeflowaiConfig(input.workspacePath).config.paths?.workflowDocsRoot ?? "").trim() || DEFAULT_WORKFLOW_DOCS_ROOT,
  );
  return joinRelPath(
    workflowDocsRoot,
    DEFAULT_FEATURE_ROOT_DIR,
    buildIntakeSegment(input.intake),
    buildRoleSegment(input.workflow, input.node, input.role),
  );
}

/** Builds the stable task-title segment used by default feature artifact paths. */
export function buildTaskTitlePathSegment(intake: TaskIntake): string {
  return sanitizePathSegment(getTaskIntakeTitle(intake), "未命名需求", 48);
}

function buildIntakeSegment(intake: TaskIntake): string {
  const readableName = buildTaskTitlePathSegment(intake);
  const shortId = sanitizeIdFragment(String(intake.id ?? ""));
  return shortId ? `${readableName}--${shortId}` : readableName;
}

function buildRoleSegment(workflow: WorkflowRuntimeDefinition, node: WorkflowNode, role: RoleDefinition): string {
  const roleName = sanitizePathSegment(role.name, "未命名角色", 40);
  const duplicatedRoleUsage = workflow.nodes.filter((item) => item.type === "role" && item.roleId === node.roleId).length > 1;
  if (!duplicatedRoleUsage) return roleName;
  const nodeSuffix = sanitizePathSegment(node.id || node.label, "node", 24);
  return `${roleName}--${nodeSuffix}`;
}

function sanitizeIdFragment(raw: string): string {
  const cleaned = String(raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.slice(0, 8);
}

function joinRelPath(...segments: Array<string | null | undefined>): string {
  return segments
    .map((segment) => normalizeRelPath(segment))
    .filter(Boolean)
    .join("/");
}

function normalizeRelPath(filePath: string | null | undefined): string {
  return String(filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function sanitizePathSegment(raw: string, fallback: string, maxLength: number): string {
  const value = String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\- ]+|[.\- ]+$/g, "")
    .trim();
  const normalized = avoidWindowsReservedPathSegment(value || fallback);
  const sliced = Array.from(normalized).slice(0, Math.max(1, maxLength)).join("");
  return avoidWindowsReservedPathSegment(sliced.replace(/[.\- ]+$/g, "") || fallback);
}

/** Avoids Windows device names while keeping the segment readable. */
function avoidWindowsReservedPathSegment(segment: string): string {
  return WINDOWS_RESERVED_PATH_SEGMENT_RE.test(segment) ? `${segment}-safe` : segment;
}

