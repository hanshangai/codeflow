/** 包目录与归档必须二选一；当前 dist 后装，baseline proof 经同 payload 验签后附入。 */
export function prepareDesktopResources(input: {
  archive?: string;
  clientPackageDir?: string;
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
