import type { PublicBestPracticeArticleDetail } from "@codeflowai/shared";
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
const BEST_PRACTICE_SEO_MARKER = "codeflow-best-practice-seo";
const CANONICAL_DIRECTORY_PATHS = new Set([
  "/guide",
  "/best-practices",
  "/contact",
  "/upgrade",
  "/data-security-commitment",
]);
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

/** 解析公开页面 SEO；应用、登录和未知路由统一禁止索引。 */
export function resolvePageSeo(path: string): PageSeo {
  const normalizedPath = normalizePath(path);
  const fixedPage = publicPageByPath.get(normalizedPath);
  let seo: PageSeo;
  if (fixedPage) {
    seo = {
      title: fixedPage.title,
      description: fixedPage.description,
      canonicalPath: canonicalPublicPath(fixedPage.path),
      robots: "index, follow",
      type: "website",
    };
  } else {
    if (readBestPracticeDetailSlug(normalizedPath) !== null) {
      seo = {
        title: "最佳实践文章 | CodeFlow",
        description: "查看 CodeFlow 最佳实践文章。",
        canonicalPath: null,
        robots: "noindex, nofollow",
        type: "article",
      };
    } else {
      seo = {
        title: "CodeFlow",
        description: "CodeFlow AI 软件研发协作平台。",
        canonicalPath: null,
        robots: "noindex, nofollow",
        type: "website",
      };
    }
  }
  return applyIndexingPolicy(seo);
}

/** 根据已加载的公开文章生成与 Server 首个响应一致的动态 SEO。 */
export function resolveBestPracticeArticleSeo(article: PublicBestPracticeArticleDetail): PageSeo {
  return applyIndexingPolicy({
    title: `${article.title} | CodeFlow 最佳实践`,
    description: article.summary,
    canonicalPath: `/best-practices/${article.slug}`,
    robots: "index, follow",
    type: "article",
  });
}

/** 在 SPA 路由切换后同步浏览器和爬虫可见的页面元数据。 */
export function applyPageSeo(path: string): void {
  if (typeof document === "undefined") return;
  const normalizedPath = normalizePath(path);
  const detailSlug = readBestPracticeDetailSlug(normalizedPath);
  if (detailSlug !== null && readNamedMeta(BEST_PRACTICE_SEO_MARKER) === detailSlug) return;
  applyPageSeoBody(resolvePageSeo(normalizedPath), detailSlug);
}

/** 写入页面元信息并清理文章级标记。 */
function applyPageSeoBody(seo: PageSeo, detailSlug: string | null): void {
  applyResolvedPageSeo(seo);
  if (detailSlug !== null) {
    setNamedMeta(BEST_PRACTICE_SEO_MARKER, detailSlug);
  } else {
    removeNamedMeta(BEST_PRACTICE_SEO_MARKER);
  }
  removePropertyMeta("article:published_time");
  removePropertyMeta("article:modified_time");
}

/** 在公开文章加载成功后同步动态 canonical、Open Graph 和发布时间。 */
export function applyBestPracticeArticleSeo(article: PublicBestPracticeArticleDetail): void {
  if (typeof document === "undefined") return;
  applyResolvedPageSeo(resolveBestPracticeArticleSeo(article));
  setNamedMeta(BEST_PRACTICE_SEO_MARKER, article.slug);
  setPropertyMeta("article:published_time", new Date(article.publishedAt).toISOString());
  setPropertyMeta("article:modified_time", new Date(article.updatedAt).toISOString());
}

/** 在详情不存在或加载失败时清除旧 canonical 并阻止索引。 */
export function applyBestPracticeArticleUnavailableSeo(path: string): void {
  if (typeof document === "undefined") return;
  const slug = readBestPracticeDetailSlug(normalizePath(path));
  applyResolvedPageSeo(resolvePageSeo(path));
  if (slug !== null) setNamedMeta(BEST_PRACTICE_SEO_MARKER, slug);
  removePropertyMeta("article:published_time");
  removePropertyMeta("article:modified_time");
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

/** 将一个已解析页面 SEO 对象写入浏览器 head。 */
function applyResolvedPageSeo(seo: PageSeo): void {
  const siteOrigin = resolveSiteOrigin(import.meta.env.VITE_CODEFLOWAI_SITE_ORIGIN);
  const canonicalUrl = seo.canonicalPath ? new URL(seo.canonicalPath, `${siteOrigin}/`).toString() : null;

  document.title = seo.title;
  setNamedMeta("description", seo.description);
  setNamedMeta("robots", seo.robots);
  setPropertyMeta("og:title", seo.title);
  setPropertyMeta("og:description", seo.description);
  setPropertyMeta("og:type", seo.type);

  const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonicalUrl) {
    const link = canonical ?? document.head.appendChild(document.createElement("link"));
    link.rel = "canonical";
    link.href = canonicalUrl;
    setPropertyMeta("og:url", canonicalUrl);
  } else {
    canonical?.remove();
    document.head.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.remove();
  }
}

/** 读取最佳实践单段 slug；列表和其他页面返回 null。 */
function readBestPracticeDetailSlug(path: string): string | null {
  return path.match(/^\/best-practices\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u)?.[1] ?? null;
}

function normalizePath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/\/+$/u, "");
  return normalized || "/";
}

/** 判断公开路径是否为目录型路由：这类地址只有带尾斜杠才是最终 200 页面。 */
function isCanonicalDirectoryPath(path: string): boolean {
  return CANONICAL_DIRECTORY_PATHS.has(path);
}

/** 将目录型公开页规范到 Caddy 返回 200 的尾斜杠地址。 */
function canonicalPublicPath(path: string): string {
  const normalized = normalizePath(path);
  return isCanonicalDirectoryPath(normalized) ? `${normalized}/` : normalized;
}

function setNamedMeta(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.name = name;
    document.head.appendChild(element);
  }
  element.content = content;
}

/** 读取一个命名 meta 的当前值。 */
function readNamedMeta(name: string): string | null {
  return document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
}

/** 删除一个不应延续到当前路由的命名 meta。 */
function removeNamedMeta(name: string): void {
  document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.remove();
}

function setPropertyMeta(property: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute("property", property);
    document.head.appendChild(element);
  }
  element.content = content;
}

/** 删除一个不应延续到当前路由的 Open Graph/article meta。 */
function removePropertyMeta(property: string): void {
  document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.remove();
}
