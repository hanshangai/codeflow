import type { SoftwareInstallEnvironment, SoftwareUpdateStatus } from "@codeflowai/shared";

export type SoftwareUpdateSnapshot = {
  items: SoftwareUpdateStatus[];
  environment: SoftwareInstallEnvironment | null;
};

/** 按工作区保留上次快照；模块级缓存才能跨面板卸载/重新挂载复用。 */
export const softwareUpdateSnapshots = new Map<string, SoftwareUpdateSnapshot>();
