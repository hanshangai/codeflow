import publicPagesJson from "./publicPages.json";

type PublicPageConfig = {
  path: string;
  title: string;
  description: string;
  changefreq: string;
  priority: number;
};

export type PageSeo = {
  title: string;
  description: string;
  canonicalPath: string | null;
  robots: "index, follow" | "noindex, nofollow";
  type: "website" | "article";
};

const DEFAULT_SITE_ORIGIN = "https://codeflowai.cn";
const publicPages = publicPagesJson as PublicPageConfig[];
const publicPageByPath = new Map(publicPages.map((page) => [page.path, page]));

/** 根据部署配置生成规范站点 Origin，非法配置退回官网地址。 */
export function resolveSiteOrigin(rawValue: string | null | undefined): string {
  try {
    return new URL(String(rawValue ?? "").trim() || DEFAULT_SITE_ORIGIN).origin;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

/** 仅首页提供 SEO；所有非首页路由统一禁止索引。 */
export function resolvePageSeo(path: string): PageSeo {
  const normalizedPath = normalizePath(path);
  const fixedPage = normalizedPath === "/" ? publicPageByPath.get("/") : undefined;
  let seo: PageSeo;
  if (fixedPage) {
    seo = {
      title: fixedPage.title,
      description: fixedPage.description,
      canonicalPath: "/",
      robots: "index, follow",
      type: "website",
    };
  } else {
    seo = { title: "CodeFlow", description: "", canonicalPath: null, robots: "noindex, nofollow", type: "website" };
  }
  return applyIndexingPolicy(seo);
}

/** 路由切换统一清理旧 SEO，回到首页时恢复首页元信息。 */
export function applyPageSeo(path: string): void {
  if (typeof document === "undefined") return;
  applyResolvedPageSeo(resolvePageSeo(path));
}

/** 将非生产构建统一降为 noindex，并移除其 canonical，避免测试地址进入索引。 */
function applyIndexingPolicy(seo: PageSeo): PageSeo {
  if (isSeoIndexingEnabled() || seo.robots === "noindex, nofollow") return seo;
  return { ...seo, canonicalPath: null, robots: "noindex, nofollow" };
}

/** 读取 Web 构建注入的 SEO 开关；未配置时保持本地开发和生产兼容行为。 */
function isSeoIndexingEnabled(): boolean {
  const value = String(import.meta.env.VITE_CODEFLOWAI_SEO_INDEXING_ENABLED ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

/** 清除遗留元信息后，仅为可索引首页写入完整 SEO。 */
function applyResolvedPageSeo(seo: PageSeo): void {
  const siteOrigin = resolveSiteOrigin(import.meta.env.VITE_CODEFLOWAI_SITE_ORIGIN);
  const canonicalUrl = seo.canonicalPath ? new URL(seo.canonicalPath, `${siteOrigin}/`).toString() : null;

  document.title = seo.title;
  document.head.querySelectorAll('link[rel="canonical"], script[type="application/ld+json"], meta[property], meta[name="description"], meta[name="keywords"], meta[name="codeflow-best-practice-seo"], meta[name="twitter:card"], meta[name="twitter:title"], meta[name="twitter:description"], meta[name="twitter:image"]')
    .forEach(element => element.remove());
  setNamedMeta("robots", seo.robots);
  if (!canonicalUrl) return;
  setNamedMeta("description", seo.description);
  setPropertyMeta("og:title", seo.title);
  setPropertyMeta("og:description", seo.description);
  setPropertyMeta("og:type", seo.type);

  const link = document.head.appendChild(document.createElement("link"));
  link.rel = "canonical";
  link.href = canonicalUrl;
  setPropertyMeta("og:url", canonicalUrl);
  setPropertyMeta("og:image", new URL("/images/landing/efficiency-workbench.png", siteOrigin).toString());
  const structuredData = document.head.appendChild(document.createElement("script"));
  structuredData.type = "application/ld+json";
  structuredData.setAttribute("data-seo-structured-data", "");
  structuredData.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", name: seo.title, description: seo.description, url: canonicalUrl, inLanguage: "zh-CN", isPartOf: { "@type": "WebSite", name: "CodeFlow", url: canonicalUrl } });
}

/** 统一尾斜杠，但不把未知地址归并为首页。 */
function normalizePath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/\/+$/u, "");
  return normalized || "/";
}

/** 创建或更新命名元信息。 */
function setNamedMeta(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.name = name;
    document.head.appendChild(element);
  }
  element.content = content;
}

/** 创建或更新首页 Open Graph 元信息。 */
function setPropertyMeta(property: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute("property", property);
    document.head.appendChild(element);
  }
  element.content = content;
}
