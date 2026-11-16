import { ref } from "vue";

/** 桌面登录弹框的跨组件状态；模型配置引导据此避免叠加弹窗。 */
export const desktopAuthModalOpen = ref(false);
