import type { ShellReleaseFile } from "@codeflowai/shared";

/** 只读检查已有密钥与信任，不构建或生成任何发布工件。 */
export function validateShellReleaseSigningInputs(input: {
  candidateDirectory: string;
  shellId: string;
  version?: string;
  planFile: string;
  root?: string;
  allowDirty?: boolean;
  createdAt: string;
  expiresAt: string;
  keyId: string;
  privateKeyFile: string;
  trustedKeysFile: string;
  outputDir: string;
  /** 稳定签名工件根；默认用户目录 .codeflow/shell-releases/<计划环境>。 */
  historyDir?: string;
  cacheDir?: string;
}): Promise<{ shellId: string; keyId: string; privateKeyFile: string }>;

/** 从完整候选目录生成已签名且仅含清单和安装器的不可变壳包。 */
export function prepareShellRelease(input: {
  candidateDirectory: string;
  shellId: string;
  version?: string;
  planFile: string;
  root?: string;
  allowDirty?: boolean;
  createdAt: string;
  expiresAt: string;
  keyId: string;
  privateKeyFile: string;
  trustedKeysFile: string;
  outputDir: string;
  /** 跨请求保留工件；重试返回该目录中原有的已签名包。 */
  historyDir?: string;
  cacheDir?: string;
}, dependencies?: {
  buildShellInstaller?: (input: { candidateDirectory: string; shellId: string; outputDir: string; cacheDir?: string }) => Promise<{
    executablePath: string;
    shellId: string;
    files: ShellReleaseFile[];
  }>;
}): Promise<{ shellId: string; installerSha256: string; manifestSha256: string; packageDir: string }>;
