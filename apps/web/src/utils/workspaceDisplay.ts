import type { WorkspaceSummary } from "@codeflowai/shared";

import { workspaceIdsReferToSameWorkspace } from "./workspaceId";

export function workspacePathBasename(path: string | null | undefined): string {
  const normalized = String(path ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function isGeneratedWorkspaceTitle(title: string, workspaceId: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedTitle) return true;
  if (normalizedTitle === normalizedWorkspaceId) return true;
  if (workspaceIdsReferToSameWorkspace(normalizedTitle, normalizedWorkspaceId)) return true;

  const beforeSlash = normalizedTitle.split("/")[0]?.trim() ?? "";
  if (beforeSlash && workspaceIdsReferToSameWorkspace(beforeSlash, normalizedWorkspaceId)) return true;

  return normalizedTitle.includes("devlocal:") && normalizedTitle.length > 24;
}

export function getWorkspaceDisplayTitle(workspace: Pick<WorkspaceSummary, "id" | "title" | "path" | "kind" | "shared">): string {
  if (workspace.kind === "shared" || workspace.shared) {
    return String(workspace.shared?.hostLabel || workspace.title || workspace.shared?.displayName || "共享工作区").trim();
  }

  const title = String(workspace.title ?? "").trim();
  if (title && !isGeneratedWorkspaceTitle(title, String(workspace.id))) return title;
  return workspacePathBasename(workspace.path) || title || String(workspace.id);
}

/** 返回工作区入口类型文案；只区分真实共享入口和本地入口。 */
export function getWorkspaceKindLabel(workspace: Pick<WorkspaceSummary, "kind" | "shared">): string {
  return workspace.kind === "shared" || workspace.shared ? "共享工作区" : "本地工作区";
}

export function getSharedWorkspaceOwnerLabel(workspace: Pick<WorkspaceSummary, "shared">): string {
  return String(
    workspace.shared?.hostOwnerName
    || workspace.shared?.hostOwnerEmail
    || workspace.shared?.workspaceAdminName
    || workspace.shared?.workspaceAdminEmail
    || "",
  ).trim();
}
