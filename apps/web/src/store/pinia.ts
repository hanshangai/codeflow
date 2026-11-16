import { createPinia } from "pinia";
import persistedstate from "pinia-plugin-persistedstate";

export const pinia = createPinia();

pinia.use(persistedstate);
