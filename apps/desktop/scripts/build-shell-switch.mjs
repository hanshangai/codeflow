import { buildShellNativeTool } from "./build-shell-launcher.mjs";

/** 复用原生启动器的缓存和独占输出约束，返回未执行的退出后切换器。 */
export async function buildShellSwitch(input) {
  return await buildShellNativeTool(input, "switch");
}
