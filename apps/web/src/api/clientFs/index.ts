import type { ClientDirectoryTreeRequestBody, ClientDirectoryTreeResponseBody } from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "../request";

/** 请求目标 Client 本机目录树；用于创建 workspace 前选择绝对目录。 */
export async function fetchClientDirectoryTree(ctx: ApiRequestContext, body: ClientDirectoryTreeRequestBody) {
  return requestJson<ClientDirectoryTreeResponseBody>(ctx, { method: "POST", path: "/api/client-fs/directory-tree", body });
}
