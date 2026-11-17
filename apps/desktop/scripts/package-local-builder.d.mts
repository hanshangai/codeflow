export function toBuilderVersion(version: string): string;
export function resolveElectronVersion(): Promise<string>;
/** 返回仅适用于当前构建机平台与架构的已安装 Electron 目录及精确版本。 */
export function resolveInstalledElectronDist(input?: {
  electronPackageDir?: string;
  platform?: string;
  arch?: string;
}): Promise<{ electronDist: string; electronVersion: string }>;
export function removeBuilderProject(stage: string): Promise<void>;
export function createBuilderProject(desktopDir: string, shellVersion: string): Promise<string>;
