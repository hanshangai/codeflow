import type {
  GitStatusRequestBody, GitStatusResponseBody,
  GitDiffRequestBody, GitDiffResponseBody,
  GitDiffFilesRequestBody, GitDiffFilesResponseBody,
  GitStageRequestBody, GitUnstageRequestBody, GitDiscardRequestBody,
  GitCommitRequestBody, GitCommitResponseBody,
  GitLogRequestBody, GitLogResponseBody,
  GitShowRequestBody, GitShowResponseBody,
  GitShowFileDiffRequestBody, GitShowFileDiffResponseBody,
  GitBranchListRequestBody, GitBranchListResponseBody,
  GitBranchCreateRequestBody, GitBranchCreateResponseBody,
  GitBranchSwitchRequestBody, GitBranchSwitchResponseBody,
  GitBranchDeleteRequestBody, GitBranchDeleteResponseBody,
} from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "../request";

export async function fetchGitStatus(ctx: ApiRequestContext, body: GitStatusRequestBody) {
  return requestJson<GitStatusResponseBody>(ctx, { method: "POST", path: "/api/git/status", body });
}

export async function fetchGitDiff(ctx: ApiRequestContext, body: GitDiffRequestBody) {
  return requestJson<GitDiffResponseBody>(ctx, { method: "POST", path: "/api/git/diff", body });
}

export async function fetchGitDiffFiles(ctx: ApiRequestContext, body: GitDiffFilesRequestBody) {
  return requestJson<GitDiffFilesResponseBody>(ctx, { method: "POST", path: "/api/git/diffFiles", body });
}

export async function fetchGitStage(ctx: ApiRequestContext, body: GitStageRequestBody) {
  return requestJson<{ ok: true }>(ctx, { method: "POST", path: "/api/git/stage", body });
}

export async function fetchGitUnstage(ctx: ApiRequestContext, body: GitUnstageRequestBody) {
  return requestJson<{ ok: true }>(ctx, { method: "POST", path: "/api/git/unstage", body });
}

export async function fetchGitDiscard(ctx: ApiRequestContext, body: GitDiscardRequestBody) {
  return requestJson<{ ok: true }>(ctx, { method: "POST", path: "/api/git/discard", body });
}

export async function fetchGitCommit(ctx: ApiRequestContext, body: GitCommitRequestBody) {
  return requestJson<GitCommitResponseBody>(ctx, { method: "POST", path: "/api/git/commit", body });
}

export async function fetchGitLog(ctx: ApiRequestContext, body: GitLogRequestBody) {
  return requestJson<GitLogResponseBody>(ctx, { method: "POST", path: "/api/git/log", body });
}

export async function fetchGitShow(ctx: ApiRequestContext, body: GitShowRequestBody) {
  return requestJson<GitShowResponseBody>(ctx, { method: "POST", path: "/api/git/show", body });
}

export async function fetchGitShowFileDiff(ctx: ApiRequestContext, body: GitShowFileDiffRequestBody) {
  return requestJson<GitShowFileDiffResponseBody>(ctx, { method: "POST", path: "/api/git/showFileDiff", body });
}

export async function fetchGitBranchList(ctx: ApiRequestContext, body: GitBranchListRequestBody) {
  return requestJson<GitBranchListResponseBody>(ctx, { method: "POST", path: "/api/git/branch/list", body });
}

export async function fetchGitBranchCreate(ctx: ApiRequestContext, body: GitBranchCreateRequestBody) {
  return requestJson<GitBranchCreateResponseBody>(ctx, { method: "POST", path: "/api/git/branch/create", body });
}

export async function fetchGitBranchSwitch(ctx: ApiRequestContext, body: GitBranchSwitchRequestBody) {
  return requestJson<GitBranchSwitchResponseBody>(ctx, { method: "POST", path: "/api/git/branch/switch", body });
}

export async function fetchGitBranchDelete(ctx: ApiRequestContext, body: GitBranchDeleteRequestBody) {
  return requestJson<GitBranchDeleteResponseBody>(ctx, { method: "POST", path: "/api/git/branch/delete", body });
}

