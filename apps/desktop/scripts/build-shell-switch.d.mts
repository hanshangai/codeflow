/** 独占输出中编译退出后切换器，不安装、不启动、不发布。 */
export function buildShellSwitch(input: { outputDir: string; cacheDir?: string; iconPath?: string; version?: string }): Promise<string>;
