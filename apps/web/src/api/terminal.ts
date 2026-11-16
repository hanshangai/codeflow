import type {
  ListTerminalActionsResponseBody,
  ListTerminalShellsResponseBody,
  SaveTerminalActionsRequestBody,
  SaveTerminalActionsResponseBody,
  TerminalAction,
  TerminalShellOption,
} from "@codeflowai/shared";

import { type ApiRequestContext, requestJson } from "./request";

/** 读取目标 Client 本机实际可用的终端 Shell 选项。 */
export async function listTerminalShells(ctx: ApiRequestContext, workspaceId: string): Promise<TerminalShellOption[]> {
  const res = await requestJson<ListTerminalShellsResponseBody>(ctx, {
    method: "GET",
    path: `/api/terminal/shells?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
  if (!res.ok) throw new Error(res.message);
  return res.shells;
}

export async function listTerminalActions(ctx: ApiRequestContext, workspaceId: string): Promise<TerminalAction[]> {
  const res = await requestJson<ListTerminalActionsResponseBody>(ctx, {
    method: "GET",
    path: `/api/terminal/actions?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
  if (!res.ok) throw new Error(res.message);
  return res.actions;
}

export async function saveTerminalActions(
  ctx: ApiRequestContext,
  body: SaveTerminalActionsRequestBody,
): Promise<TerminalAction[]> {
  const res = await requestJson<SaveTerminalActionsResponseBody>(ctx, {
    method: "POST",
    path: "/api/terminal/actions",
    body,
  });
  if (!res.ok) throw new Error(res.message);
  return res.actions;
}

