/** 组装完整资源；显式 baseline proof 仅在同 payload 验签后按原字节附入。 */
export function prepareDesktopResources(input: {
  archive: string;
  clientDir: string;
  webDir: string;
  outputDir: string;
  trustedReleaseKeysFile?: string;
  baselineReleaseManifestFile?: string;
  updateServerOrigin?: string;
  npmPackageDir?: string;
  cliRuntimeManifestFile?: string;
  runtimeExecutable?: string;
  expectedClientVersion?: string;
}): Promise<void>;

export function verifyDesktopClientRuntime(input: {
  clientDir: string;
  runtimeExecutable?: string;
  expectedClientVersion?: string;
}): Promise<{ schemaVersion: number; platform: string; arch: string; nodeMajor: number; modules: string }>;
