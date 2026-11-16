// 与 Web stores 复用同一个 ESM 实例；通过包公开声明保留完整类型。
const pinia = await import(new URL("../../apps/web/node_modules/pinia/dist/pinia.mjs", import.meta.url).href) as typeof import("../../apps/web/node_modules/pinia");
export const { createPinia, setActivePinia } = pinia;
