import type { ShellReleaseFile } from "@codeflowai/shared";

/** 新独占输出及缓存内生成完整候选安装器，不安装、签名或发布。 */
export function buildShellInstaller(input: {
  candidateDirectory: string; shellId: string; outputDir: string; cacheDir?: string;
}): Promise<{ executablePath: string; shellId: string; files: ShellReleaseFile[] }>;
