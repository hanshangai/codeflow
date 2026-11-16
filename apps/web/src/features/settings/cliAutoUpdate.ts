/** CLI 自动更新开关；未写入时默认开启。 */
export const CLI_AUTO_UPDATE_KEY = "codeflowai.cli-auto-update";

/** 读取自动更新设置，默认选中。 */
export function isCliAutoUpdateEnabled(): boolean {
  return localStorage.getItem(CLI_AUTO_UPDATE_KEY) !== "0";
}

/** 保存自动更新设置；开启时移除显式关闭标记。 */
export function setCliAutoUpdateEnabled(value: boolean): void {
  if (value) localStorage.removeItem(CLI_AUTO_UPDATE_KEY);
  else localStorage.setItem(CLI_AUTO_UPDATE_KEY, "0");
}
