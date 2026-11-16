import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("best practice list is an indexable fixed page", () => {
  const publicPages = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "src", "seo", "publicPages.json"), "utf8"));
  const page = publicPages.find((candidate: { path?: string }) => candidate.path === "/best-practices");

  assert.equal(page?.title, "最佳实践 | CodeFlow");
  assert.equal(page?.changefreq, "weekly");
  assert.equal(page?.priority, 0.8);
});

test("best practice detail updates SEO after loading and preserves a matching Server snapshot", () => {
  const seoSource = fs.readFileSync(path.join(WEB_ROOT, "src", "seo", "pageSeo.ts"), "utf8");
  const pageSource = fs.readFileSync(
    path.join(WEB_ROOT, "src", "features", "best-practices", "components", "BestPracticePage.vue"),
    "utf8",
  );

  assert.match(seoSource, /readNamedMeta\(BEST_PRACTICE_SEO_MARKER\) === detailSlug\) return/u);
  assert.match(seoSource, /VITE_CODEFLOWAI_SEO_INDEXING_ENABLED/u);
  assert.match(seoSource, /applyIndexingPolicy\(seo\)/u);
  assert.match(seoSource, /canonicalPath: `\/best-practices\/\$\{article\.slug\}`/u);
  assert.match(seoSource, /robots: "index, follow"[\s\S]*type: "article"/u);
  assert.match(seoSource, /robots: "noindex, nofollow"/u);
  assert.match(pageSource, /applyBestPracticeArticleSeo\(result\.article\)/u);
  assert.match(pageSource, /applyBestPracticeArticleUnavailableSeo\(route\.path\)/u);
});
