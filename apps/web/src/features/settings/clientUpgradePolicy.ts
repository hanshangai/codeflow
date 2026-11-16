import { compareNumericVersion, type OnlineClientInfo } from "@codeflowai/shared";

/** 源码运行不参与安装包版本提醒；未声明能力的旧 Client 保留原有比较。 */
export function clientNeedsPackageUpgrade(
  client: Pick<OnlineClientInfo, "version" | "capabilities">,
  latestVersion: string | null,
): boolean {
  if (client.capabilities?.selfUpgrade === false || !client.version || !latestVersion) return false;
  return compareNumericVersion(client.version, latestVersion) < 0;
}

/** 仅当 Client 实际上报版本达到升级目标时才允许进入成功态。 */
export function isClientUpgradeTargetReached(clientVersion: string | null, targetVersion: string | null): boolean {
  if (!clientVersion || !targetVersion) return false;
  return compareNumericVersion(clientVersion, targetVersion) >= 0;
}

/** 识别 Client 连接切换期间的内部退役提示，避免把路由细节暴露给用户。 */
export function isClientConnectionRetiredMessage(message: unknown): boolean {
  return typeof message === "string" && message.trim().startsWith("client 连接已退役：");
}
