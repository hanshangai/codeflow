import { ref } from "vue";

/** 顶栏「应用更新」复用托盘检查更新弹框，每次自增触发一次检查。 */
export const desktopUpdateCheckRequestTick = ref(0);

export function requestDesktopUpdateCheck(): void {
  desktopUpdateCheckRequestTick.value += 1;
}
