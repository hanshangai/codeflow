/**
 * `generate-site-seo.mjs` 的最小类型声明。
 * 仅声明测试实际引用的导出；新增引用时在此补充对应声明，避免测试绕过类型检查。
 */

/** 不参与索引的私有路由前缀，与站点 SEO 生成逻辑共用同一份清单。 */
export const NOINDEX_PATHS: readonly string[];
