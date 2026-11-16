import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "apps", "web");
const PUBLIC_PAGES_FILE = path.join(WEB_DIR, "src", "seo", "publicPages.json");
const SEO_OUTPUT_DIR = path.resolve(String(process.env.CODEFLOWAI_SEO_OUTPUT_DIR || WEB_DIR));
const SEO_MANIFEST_FILE = path.join(SEO_OUTPUT_DIR, "seo", "public-urls.json");
const SITEMAP_FILE = path.join(SEO_OUTPUT_DIR, "public", "sitemap.xml");
const ROBOTS_FILE = path.join(SEO_OUTPUT_DIR, "public", "robots.txt");
const DIST_DIR = path.join(WEB_DIR, "dist");
const DEFAULT_SITE_ORIGIN = "https://codeflowai.cn";
const CANONICAL_DIRECTORY_PATHS = new Set([
  "/best-practices",
  "/contact",
  "/upgrade",
  "/data-security-commitment",
]);
const SHOULD_PRERENDER = process.argv.includes("--prerender");
export const NOINDEX_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/forgot",
  "/chat",
  "/h5",
  "/h5/login",
  "/admin",
  "/orchestration/workspace",
  "/orchestration/assets",
  "/knowledge",
  "/payment/enterprise",
  "/payment/verification",
  "/office-h5/wecom",
  "/office-h5/dingtalk",
];

/** 生成 sitemap、百度推送清单，并在构建后输出路由级静态 HTML。 */
function main() {
  const siteOrigin = resolveSiteOrigin(process.env.VITE_CODEFLOWAI_SITE_ORIGIN);
  const indexingEnabled = resolveSeoIndexingEnabled();
  const pages = collectPublicPages();
  writeSeoManifest(siteOrigin, pages, indexingEnabled);
  writeSitemap(siteOrigin, pages, indexingEnabled);
  writeRobots(siteOrigin, indexingEnabled);
  log(`generated sitemap and URL manifest: ${indexingEnabled ? pages.length : 0} indexable pages; indexing=${indexingEnabled}`);
  if (SHOULD_PRERENDER) {
    prerenderPages(siteOrigin, pages, indexingEnabled);
    log(`prerendered ${pages.length} public pages and ${NOINDEX_PATHS.length} private routes`);
  }
}

/** 生成静态与动态 sitemap 共用的爬虫入口，避免部署域名写死。 */
export function writeRobots(siteOrigin, indexingEnabled = resolveSeoIndexingEnabled()) {
  fs.mkdirSync(path.dirname(ROBOTS_FILE), { recursive: true });
  fs.writeFileSync(ROBOTS_FILE, buildRobotsContent(siteOrigin, indexingEnabled), "utf-8");
}

/** 按目标环境生成爬虫规则；非索引环境禁止全站抓取且不声明 Sitemap。 */
export function buildRobotsContent(siteOrigin, indexingEnabled = true) {
  if (!indexingEnabled) return ["User-agent: *", "Disallow: /", ""].join("\n");
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /auth/",
    "Disallow: /chat",
    "Disallow: /office-h5/",
    "Disallow: /orchestration/",
    "Disallow: /payment/",
    "",
    `Sitemap: ${new URL("/sitemap.xml", `${siteOrigin}/`).toString()}`,
    `Sitemap: ${new URL("/best-practices-sitemap.xml", `${siteOrigin}/`).toString()}`,
    "",
  ].join("\n");
}

/** 固定营销页构成公开可索引页面。 */
export function collectPublicPages() {
  const fixedPages = JSON.parse(fs.readFileSync(PUBLIC_PAGES_FILE, "utf-8"));
  if (!Array.isArray(fixedPages)) throw new Error("publicPages.json 必须是数组");
  return fixedPages.map(validateFixedPage);
}

/** 写入结构化 URL 清单，推送工具不需要反向解析 XML。 */
function writeSeoManifest(siteOrigin, pages, indexingEnabled) {
  const manifest = {
    schemaVersion: 1,
    siteOrigin,
    pages: (indexingEnabled ? pages : []).map((page) => ({
      path: page.path,
      url: buildCanonicalUrl(siteOrigin, page.path),
      title: page.title,
    })),
  };
  fs.mkdirSync(path.dirname(SEO_MANIFEST_FILE), { recursive: true });
  fs.writeFileSync(SEO_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** 生成符合 sitemap.org 协议的公开页面清单。 */
function writeSitemap(siteOrigin, pages, indexingEnabled) {
  const urls = (indexingEnabled ? pages : []).map((page) => [
    "  <url>",
    `    <loc>${escapeXml(buildCanonicalUrl(siteOrigin, page.path))}</loc>`,
    `    <changefreq>${escapeXml(page.changefreq)}</changefreq>`,
    `    <priority>${Number(page.priority).toFixed(1)}</priority>`,
    "  </url>",
  ].join("\n"));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(SITEMAP_FILE), { recursive: true });
  fs.writeFileSync(SITEMAP_FILE, xml, "utf-8");
}

/** 为公开页面写入独立 HTML；不公开路由额外生成 noindex 入口。 */
function prerenderPages(siteOrigin, pages, indexingEnabled) {
  const indexFile = path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(indexFile)) throw new Error(`缺少 Vite 构建产物：${indexFile}`);
  const appShell = resetPrerenderedAppShell(fs.readFileSync(indexFile, "utf-8"));

  for (const page of pages) {
    writeRouteHtml(page.path, renderPublicPageHtml(appShell, siteOrigin, page, indexingEnabled));
  }
  for (const routePath of NOINDEX_PATHS) {
    writeRouteHtml(routePath, renderNoindexPageHtml(appShell));
  }
}

/** 允许 seo:prerender 独立重复执行，不依赖 Vite 每次先清空 dist。 */
function resetPrerenderedAppShell(html) {
  if (html.includes('<div id="app"></div>')) return html;
  const pattern = /<div id="app"><main\b[^>]*\bdata-seo-prerender[\s\S]*?<\/main><\/div>/iu;
  if (!pattern.test(html)) throw new Error("Vite index.html 缺少可识别的 #app 挂载点");
  return html.replace(pattern, '<div id="app"></div>');
}

/** 为一个公开路由写入与 Sitemap 一致的 canonical 和预渲染内容。 */
function renderPublicPageHtml(appShell, siteOrigin, page, indexingEnabled) {
  const canonicalUrl = indexingEnabled ? buildCanonicalUrl(siteOrigin, page.path) : null;
  let html = appShell;
  html = replaceTagContent(html, "title", escapeHtml(page.title));
  html = upsertMeta(html, "name", "description", page.description);
  html = upsertMeta(html, "name", "robots", indexingEnabled ? "index, follow" : "noindex, nofollow");
  html = upsertMeta(html, "property", "og:title", page.title);
  html = upsertMeta(html, "property", "og:description", page.description);
  html = upsertMeta(html, "property", "og:type", page.type || "website");
  if (canonicalUrl) {
    html = upsertMeta(html, "property", "og:url", canonicalUrl);
    html = upsertCanonical(html, canonicalUrl);
    html = upsertStructuredData(html, page, canonicalUrl);
  } else {
    html = removeMeta(html, "property", "og:url");
    html = removeCanonical(html);
    html = removeStructuredData(html);
  }
  return injectPrerenderedContent(html, renderPageContent(page));
}

/** 为私有路由生成无 canonical、无结构化数据的 noindex 页面壳。 */
function renderNoindexPageHtml(appShell) {
  let html = appShell;
  html = replaceTagContent(html, "title", "CodeFlow");
  html = upsertMeta(html, "name", "robots", "noindex, nofollow");
  html = removeCanonical(html);
  html = removeMeta(html, "property", "og:url");
  html = removeStructuredData(html);
  // 私有入口不需要 SEO 内容，保持空挂载点以缩短 H5/登录深链的首个响应。
  return html;
}

function renderPageContent(page) {
  return `<h1>${escapeHtml(page.title.replace(/\s*\|\s*CodeFlow.*$/u, ""))}</h1><p>${escapeHtml(page.description)}</p>`;
}

/** 注入可见的语义快照，使未执行 JavaScript 的爬虫和访客都能读取公开内容。 */
export function injectPrerenderedContent(html, content) {
  const wrapper = `<main data-seo-prerender style="box-sizing:border-box;max-width:960px;margin:0 auto;padding:40px 24px;color:#1f1a16;font:16px/1.75 system-ui,sans-serif"><article>${content}</article></main>`;
  if (!html.includes('<div id="app"></div>')) throw new Error("Vite index.html 缺少空的 #app 挂载点");
  return html.replace('<div id="app"></div>', `<div id="app">${wrapper}</div>`);
}

/** 为每个静态公开页写入独立的 JSON-LD，避免复用首页的套餐和页面语义。 */
export function upsertStructuredData(html, page, canonicalUrl) {
  const type = page.type === "article" ? "Article" : "WebPage";
  const value = {
    "@context": "https://schema.org",
    "@type": type,
    name: page.title,
    description: page.description,
    url: canonicalUrl,
    inLanguage: "zh-CN",
    isPartOf: {
      "@type": "WebSite",
      name: "CodeFlow",
      url: new URL("/", canonicalUrl).toString(),
    },
  };
  const script = `<script type="application/ld+json" data-seo-structured-data>${JSON.stringify(value).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e")}</script>`;
  const pattern = /<script\b[^>]*\bdata-seo-structured-data\b[^>]*>[\s\S]*?<\/script>/iu;
  if (pattern.test(html)) return html.replace(pattern, script);
  return html.replace("</head>", `    ${script}\n  </head>`);
}

function writeRouteHtml(routePath, html) {
  const normalized = routePath === "/" ? [] : routePath.split("/").filter(Boolean).map(decodeURIComponent);
  const outputDir = path.join(DIST_DIR, ...normalized);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.html"), html, "utf-8");
}

function replaceTagContent(html, tagName, content) {
  const pattern = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, "iu");
  if (!pattern.test(html)) throw new Error(`index.html 缺少 <${tagName}>`);
  return html.replace(pattern, `<${tagName}>${content}</${tagName}>`);
}

function upsertMeta(html, attribute, key, content) {
  const pattern = new RegExp(`<meta\\b[^>]*\\b${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, "iu");
  const tag = `<meta ${attribute}="${escapeHtml(key)}" content="${escapeHtml(content)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

function upsertCanonical(html, href) {
  const pattern = /<link\b[^>]*\brel=["']canonical["'][^>]*>/iu;
  const tag = `<link rel="canonical" href="${escapeHtml(href)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

/** 删除不应出现在 noindex 页面中的 canonical 标签。 */
function removeCanonical(html) {
  return html.replace(/\s*<link\b[^>]*\brel=["']canonical["'][^>]*>/iu, "");
}

/** 删除指定的 head meta 标签。 */
function removeMeta(html, attribute, key) {
  const pattern = new RegExp(`\\s*<meta\\b[^>]*\\b${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, "iu");
  return html.replace(pattern, "");
}

/** 删除静态页面 JSON-LD，避免 noindex 环境继续暴露可索引结构化数据。 */
function removeStructuredData(html) {
  return html.replace(/\s*<script\b[^>]*\bdata-seo-structured-data[^>]*>[\s\S]*?<\/script>/iu, "");
}

function validateFixedPage(page) {
  if (!page || typeof page !== "object" || !String(page.path || "").startsWith("/")) {
    throw new Error("publicPages.json 存在非法页面配置");
  }
  return { ...page, type: "website" };
}

function resolveSiteOrigin(rawValue) {
  const value = String(rawValue ?? "").trim() || DEFAULT_SITE_ORIGIN;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("站点地址只支持 HTTP/HTTPS");
  return url.origin;
}

/** 解析构建目标的索引开关；只有明确关闭值才关闭，兼容未配置的本地构建。 */
export function resolveSeoIndexingEnabled(rawValue = process.env.VITE_CODEFLOWAI_SEO_INDEXING_ENABLED) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

/** 判断公开路径是否为目录型路由：这类地址只有带尾斜杠才是最终 200 页面。 */
function isCanonicalDirectoryPath(path) {
  return CANONICAL_DIRECTORY_PATHS.has(path);
}

/** 生成与 Caddy 最终 200 地址一致的公开页面 URL。 */
function buildCanonicalUrl(siteOrigin, pagePath) {
  const normalizedPath = String(pagePath ?? "").trim().replace(/\/+$/u, "") || "/";
  const canonicalPath = isCanonicalDirectoryPath(normalizedPath)
    ? `${normalizedPath}/`
    : normalizedPath;
  return new URL(canonicalPath, `${siteOrigin}/`).toString();
}

function escapeHtml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function escapeXml(value) {
  return escapeHtml(value).replace(/'/gu, "&apos;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function log(message) {
  console.log(`[seo] ${message}`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
