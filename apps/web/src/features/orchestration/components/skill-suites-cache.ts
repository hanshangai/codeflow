import type { GetSkillSuitesResponseBody } from "@codeflowai/shared";

export const SKILL_SUITES_CACHE_TTL_MS = 30_000;
export type SkillSuitesCacheEntry = { response: GetSkillSuitesResponseBody; updatedAt: number };

/**
 * 模块级缓存：跨组件实例（Tab 切换卸载/重挂）复用。
 * 若声明在 <script setup> 内会成为实例级 Map，每次切回技能市场都会重新请求并出现加载态。
 */
export const skillSuitesCache = new Map<string, SkillSuitesCacheEntry>();
