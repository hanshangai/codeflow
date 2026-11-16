/** 复制锁定的 npm 包；包名或版本不符时在写目标前失败。 */
export function copyNpmPackage(input: {
  npmPackageDir: string;
  targetDir: string;
  expectedVersion: string;
}): Promise<void>;
