import { ref } from "vue";

/** 应用级模型 Key 引导的共享状态；空会话页据此保留配置入口。 */
export const localModelSetupGuideActive = ref(false);
/** 引导对应的本机工作区；嵌入其它工作区时不得复用该入口。 */
export const localModelSetupGuideWorkspaceId = ref<string | null>(null);
