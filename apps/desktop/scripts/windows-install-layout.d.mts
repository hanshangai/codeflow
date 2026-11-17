import type { AfterPackContext } from "electron-builder";

/** 将新平铺工件转换为固定启动器与 installation 壳，不接触运行安装。 */
export function prepareWindowsInstallLayout(input: { appOutDir: string; launcherExecutable: string }): Promise<void>;
/** NSIS 打包钩子构建固定启动器并生成版本化布局，dir 目标不使用此钩子。 */
export default function afterSign(context: AfterPackContext): Promise<void>;
