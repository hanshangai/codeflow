/** 在新独占输出及缓存目录中构建本地固定启动器，不执行安装或发布。 */
export function buildShellLauncher(input: { outputDir: string; cacheDir?: string }): Promise<string>;
