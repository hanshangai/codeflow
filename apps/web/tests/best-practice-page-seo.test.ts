import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("only the homepage has an indexable page configuration", () => {
  const publicPages = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "src", "seo", "publicPages.json"), "utf8"));
  assert.deepEqual(publicPages.map((page: { path: string }) => page.path), ["/"]);
});

test("article loading does not enable article SEO", () => {
  const seoSource = fs.readFileSync(path.join(WEB_ROOT, "src", "seo", "pageSeo.ts"), "utf8");
  const pageSource = fs.readFileSync(
    path.join(WEB_ROOT, "src", "features", "best-practices", "components", "BestPracticePage.vue"),
    "utf8",
  );

  assert.match(seoSource, /VITE_CODEFLOWAI_SEO_INDEXING_ENABLED/u);
  assert.doesNotMatch(pageSource, /applyBestPracticeArticle(?:Unavailable)?Seo/u);
});

/** 执行真实元信息模块，以最小 DOM 验证往返导航与旧文章数据清理。 */
test("homepage metadata is restored after noindex navigation and stays absent in test builds", () => {
  const nodes: any[] = [];
  const makeNode = (tag: string): any => ({ tag, attrs: {}, content: "", textContent: "", setAttribute(key: string, value: string) { this.attrs[key] = value; }, remove() { nodes.splice(nodes.indexOf(this), 1); } });
  const head = {
    appendChild(node: any) { nodes.push(node); return node; },
    querySelectorAll(selector: string) { return nodes.filter(node => selector.split(",").some(part => {
      const match = part.trim().match(/^(meta|link|script)\[([^=\]]+)(?:=["']([^"']+)["'])?\]$/u);
      return match && node.tag === match[1] && (match[3] === undefined ? node[match[2]!] !== undefined || node.attrs[match[2]!] !== undefined : (node[match[2]!] ?? node.attrs[match[2]!]) === match[3]);
    })); },
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  const document = { title: "", head, createElement: makeNode };
  const env = { VITE_CODEFLOWAI_SITE_ORIGIN: "https://example.test", VITE_CODEFLOWAI_SEO_INDEXING_ENABLED: "1" };
  const context: any = { exports: {}, document, URL, __env: env, __pages: JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "src/seo/publicPages.json"), "utf8")) };
  const source = fs.readFileSync(path.join(WEB_ROOT, "src/seo/pageSeo.ts"), "utf8")
    .replace('import publicPagesJson from "./publicPages.json";', 'const publicPagesJson = globalThis.__pages;')
    .replaceAll("import.meta.env", "globalThis.__env");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  for (const route of ["/download", "/best-practices", "/best-practices/article", "/contact", "/chat", "/unknown"]) {
    context.exports.applyPageSeo("/");
    assert.equal(head.querySelector('link[rel="canonical"]').href, "https://example.test/");
    assert.ok(head.querySelector('script[type="application/ld+json"]'));
    context.exports.applyPageSeo(route);
    assert.equal(head.querySelector('meta[name="robots"]').content, "noindex, nofollow", route);
    assert.equal(head.querySelector('link[rel="canonical"]'), null);
    assert.equal(head.querySelector('script[type="application/ld+json"]'), null);
    assert.equal(head.querySelector('meta[property="og:title"]'), null);
  }
  env.VITE_CODEFLOWAI_SEO_INDEXING_ENABLED = "0";
  context.exports.applyPageSeo("/");
  assert.equal(head.querySelector('meta[name="robots"]').content, "noindex, nofollow");
  assert.equal(head.querySelector('link[rel="canonical"]'), null);
  assert.equal(head.querySelector('script[type="application/ld+json"]'), null);
});
