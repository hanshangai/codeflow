import { logger, type WorkspaceLogEntry } from "../src/logger.js";
import type { WorkspaceId } from "@codeflowai/shared";

/** 显式测试依赖保留既有 logger 故障注入，不作为产品缺省或真实落盘证明。 */
export function testEngineWorkspaceLog(_workspaceId: WorkspaceId, entry: WorkspaceLogEntry): void {
  logger[entry.level](entry.tag, entry.message, entry.data);
}
