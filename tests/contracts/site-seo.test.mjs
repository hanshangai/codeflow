import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOINDEX_PATHS,
  buildRobotsContent,
  collectPublicPages,
  injectPrerenderedContent,
  resolveSeoIndexingEnabled,
  upsertStructuredData,
} from "../../scripts/generate-site-seo.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 在临时目录生成 SEO 产物，验证构建结果且不改写工作区文件。 */
function generateSeoOutput(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-seo-fixture-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  execFileSync(process.execPath, ["scripts/generate-site-seo.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEFLOWAI_SEO_OUTPUT_DIR: outputDir,
      VITE_CODEFLOWAI_SEO_INDEXING_ENABLED: "1",
      VITE_CODEFLOWAI_SITE_ORIGIN: "https://codeflowai.cn",
    },
    encoding: "utf8",
  });
  return outputDir;
}

test("protected knowledge and enterprise checkout entry pages are emitted for static hosting", () => {
  assert.ok(NOINDEX_PATHS.includes("/knowledge"));
  assert.ok(NOINDEX_PATHS.includes("/payment/enterprise"));
  const publicPaths = new Set(collectPublicPages().map((page) => page.path));
  assert.equal(publicPaths.has("/knowledge"), false);
  assert.equal(publicPaths.has("/payment/enterprise"), false);
});

test("only the homepage participates in SEO, other marketing routes keep noindex entry shells", () => {
  const publicPages = collectPublicPages();
  assert.deepEqual(publicPages.map(page => page.path), ["/"]);
  for (const route of ["/download", "/best-practices", "/contact", "/upgrade", "/data-security-commitment"]) {
    assert.ok(NOINDEX_PATHS.includes(route), route);
  }
});

test("generated Baidu manifest and sitemap contain the same public URL set", (t) => {
  const outputDir = generateSeoOutput(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "seo", "public-urls.json"), "utf-8"));
  const sitemap = fs.readFileSync(path.join(outputDir, "public", "sitemap.xml"), "utf-8");
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.pages.map(page => page.path), ["/"]);
  assert.equal((sitemap.match(/<loc>/gu) ?? []).length, 1);
  assert.equal(manifest.siteOrigin, "https://codeflowai.cn");
  assert.ok(manifest.pages.every((page) => page.url.startsWith("https://codeflowai.cn/")));
  for (const page of manifest.pages) {
    assert.match(sitemap, new RegExp(escapeRegExp(page.url)));
  }
  assert.doesNotMatch(sitemap, /https:\/\/codeflowai\.cn\/guide<\/loc>/u);
  assert.doesNotMatch(sitemap, /codeflow\.hanshangai\.com/u);
  assert.ok(manifest.pages.every((page) => page.path !== "/pricing"));
  assert.doesNotMatch(sitemap, /\/pricing\//u);
});

test("robots allows reading noindex responses and advertises only the homepage sitemap", (t) => {
  const outputDir = generateSeoOutput(t);
  const robots = fs.readFileSync(path.join(outputDir, "public", "robots.txt"), "utf-8");
  assert.match(robots, /^Sitemap: https:\/\/codeflowai\.cn\/sitemap\.xml$/mu);
  assert.doesNotMatch(robots, /best-practices-sitemap/u);
  assert.doesNotMatch(robots, /Disallow: \/(?:auth|chat|admin)/u);
  assert.doesNotMatch(robots, /codeflow\.hanshangai\.com/u);
});

test("non-indexable release SEO output blocks crawling without changing source assets", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-seo-output-"));
  const sourceFiles = [
    path.join(ROOT, "apps", "web", "public", "robots.txt"),
    path.join(ROOT, "apps", "web", "public", "sitemap.xml"),
    path.join(ROOT, "apps", "web", "seo", "public-urls.json"),
  ];
  const before = sourceFiles.map((filePath) => fs.readFileSync(filePath));
  try {
    execFileSync(process.execPath, ["scripts/generate-site-seo.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEFLOWAI_SEO_OUTPUT_DIR: outputDir,
        VITE_CODEFLOWAI_SEO_INDEXING_ENABLED: "0",
        VITE_CODEFLOWAI_SITE_ORIGIN: "http://test.example.com:39281",
      },
      encoding: "utf8",
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "seo", "public-urls.json"), "utf8"));
    const robots = fs.readFileSync(path.join(outputDir, "public", "robots.txt"), "utf8");
    const sitemap = fs.readFileSync(path.join(outputDir, "public", "sitemap.xml"), "utf8");
    assert.deepEqual(manifest.pages, []);
    assert.equal(robots, "User-agent: *\nDisallow: /\n");
    assert.doesNotMatch(sitemap, /<loc>/u);
    assert.equal(resolveSeoIndexingEnabled("0"), false);
    assert.equal(resolveSeoIndexingEnabled("1"), true);
    assert.equal(buildRobotsContent("http://test.example.com:39281", false), robots);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  sourceFiles.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
});

/** 使用隔离的完整构建布局验证真实 --prerender 输出，不覆盖本机 dist。 */
test("prerender keeps homepage SEO and emits plain noindex shells for every other entry", t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-home-seo-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const directory of ["scripts", "apps/web/src/seo", "apps/web/dist"]) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  for (const file of ["scripts/generate-site-seo.mjs", "apps/web/src/seo/publicPages.json"]) fs.copyFileSync(path.join(ROOT, file), path.join(fixture, file));
  const shell = fs.readFileSync(path.join(ROOT, "apps/web/index.html"), "utf8");
  fs.writeFileSync(path.join(fixture, "apps/web/dist/index.html"), shell, "utf8");
  for (const enabled of ["1", "0"]) {
    execFileSync(process.execPath, ["scripts/generate-site-seo.mjs", "--prerender"], { cwd: fixture, env: { ...process.env, CODEFLOWAI_SEO_OUTPUT_DIR: fixture, VITE_CODEFLOWAI_SITE_ORIGIN: "https://example.test", VITE_CODEFLOWAI_SEO_INDEXING_ENABLED: enabled }, encoding: "utf8" });
    const home = fs.readFileSync(path.join(fixture, "apps/web/dist/index.html"), "utf8");
    assert.match(home, enabled === "1" ? /content="index, follow"/u : /content="noindex, nofollow"/u);
    if (enabled === "1") assert.match(home, /rel="canonical" href="https:\/\/example\.test\/"/u);
    else assert.doesNotMatch(home, /canonical|application\/ld\+json/u);
    for (const route of NOINDEX_PATHS) {
      const html = fs.readFileSync(path.join(fixture, "apps/web/dist", route, "index.html"), "utf8");
      assert.match(html, /name="robots" content="noindex, nofollow"/u, route);
      assert.doesNotMatch(html, /canonical|application\/ld\+json|property="og:|<main\b[^>]*data-seo-prerender/u, route);
      assert.match(html, /<div id="app"><\/div>/u, route);
    }
  }
});

test("SEO private route snapshots include the H5 application entry", () => {
  assert.ok(NOINDEX_PATHS.includes("/h5"));
});

test("prerendered SEO snapshots expose semantic content before the Vue application mounts", () => {
  const html = injectPrerenderedContent('<body><div id="app"></div></body>', "<h1>CodeFlow</h1>");
  assert.match(html, /<main data-seo-prerender\b/u);
  assert.doesNotMatch(html, /<main data-seo-prerender hidden\b/u);
  assert.match(html, /<h1>CodeFlow<\/h1>/u);
});

test("application boot state keeps prerendered SEO content hidden until Vue mounts", () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, "apps", "web", "index.html"), "utf-8");
  const mainTs = fs.readFileSync(path.join(ROOT, "apps", "web", "src", "main.ts"), "utf-8");
  assert.match(indexHtml, /body\.app-booting #app > \[data-seo-prerender\]\s*\{\s*visibility: hidden;/u);
  assert.match(indexHtml, /<noscript>[\s\S]*visibility: visible;[\s\S]*<\/noscript>/u);
  assert.doesNotMatch(indexHtml, /body\.app-booting #app::after/u);
  assert.ok(mainTs.indexOf('app.mount("#app")') < mainTs.indexOf('document.body.classList.remove("app-booting")'));
});

test("prerendered public pages replace generic structured data with route-specific JSON-LD", () => {
  const html = upsertStructuredData(
    '<head><script type="application/ld+json" data-seo-structured-data>{}</script></head>',
    { title: "联系我们 | CodeFlow", description: "查看 CodeFlow 联系方式。", type: "website" },
    "https://codeflowai.cn/contact/",
  );
  const matched = html.match(/<script type="application\/ld\+json" data-seo-structured-data>(.*?)<\/script>/u);
  assert.ok(matched);
  assert.deepEqual(JSON.parse(matched[1]), {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "联系我们 | CodeFlow",
    description: "查看 CodeFlow 联系方式。",
    url: "https://codeflowai.cn/contact/",
    inLanguage: "zh-CN",
    isPartOf: {
      "@type": "WebSite",
      name: "CodeFlow",
      url: "https://codeflowai.cn/",
    },
  });
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
