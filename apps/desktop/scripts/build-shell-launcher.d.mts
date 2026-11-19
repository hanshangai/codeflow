/** 独占输出中构建启动器，可选图标/版本在编译时写入，不执行安装或发布。 */
export function buildShellLauncher(input: { outputDir: string; cacheDir?: string; iconPath?: string; version?: string }): Promise<string>;
/** 共享受保护的编译入口，工具类型只允许仓内启动器或退出后切换器。 */
export function buildShellNativeTool(input: { outputDir: string; cacheDir?: string; iconPath?: string; version?: string }, kind: "launcher" | "switch"): Promise<string>;
