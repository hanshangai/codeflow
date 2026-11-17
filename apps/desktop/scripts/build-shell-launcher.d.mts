/** 独占输出中构建启动器，可选图标/版本在编译时写入，不执行安装或发布。 */
export function buildShellLauncher(input: { outputDir: string; cacheDir?: string; iconPath?: string; version?: string }): Promise<string>;
