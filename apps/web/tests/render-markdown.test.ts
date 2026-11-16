import assert from "node:assert/strict";
import { test } from "node:test";

import { renderMarkdown } from "../src/features/markdown/renderMarkdown";
import { resolveMarkdownWorkspaceLinkPath, stripWorkspaceFileLineSuffix } from "../src/features/markdown/markdownWorkspaceLinks";
import { resolveMarkdownResourcePath } from "../src/features/markdown/useMarkdownResources";
import { detectPreviewType } from "../src/features/explorer/workspaceFilePreview";

test("marks local markdown images for workspace resource loading", () => {
  const html = renderMarkdown("![local](./img/a.png)", { resolveLocalImages: true });

  assert.match(html, /class="markdown-image markdown-image--loading"/u);
  assert.match(html, /data-markdown-resource="image"/u);
  assert.match(html, /data-markdown-src="\.\/img\/a\.png"/u);
});

test("renders remote markdown images directly", () => {
  const html = renderMarkdown("![remote](https://example.com/a.png)", { resolveLocalImages: true });

  assert.match(html, /src="https:\/\/example\.com\/a\.png"/u);
  assert.doesNotMatch(html, /data-markdown-resource/u);
});

test("blocks executable html while keeping common document tags", () => {
  const html = renderMarkdown("<details open><summary>More</summary><mark>ok</mark></details><script>alert(1)</script>");

  assert.match(html, /<details open>/u);
  assert.match(html, /<summary>More<\/summary>/u);
  assert.match(html, /<mark>ok<\/mark>/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test("blocks unsafe image sources from raw html", () => {
  const html = renderMarkdown('<img src="javascript:alert(1)" alt="bad">');

  assert.doesNotMatch(html, /javascript:/u);
  assert.match(html, /markdown-image-error/u);
});

test("keeps safe raw html image sources and marks local ones", () => {
  const html = renderMarkdown('<img src="../assets/pic.webp" alt="pic">', { resolveLocalImages: true });

  assert.match(html, /data-markdown-resource="image"/u);
  assert.match(html, /data-markdown-src="\.\.\/assets\/pic\.webp"/u);
});

test("keeps auto-linked markdown file names as workspace file links", () => {
  const html = renderMarkdown("定时任务流程实例调度策略方案.md");

  assert.match(html, /href="定时任务流程实例调度策略方案\.md"/u);
  assert.doesNotMatch(html, /xn--/u);
  assert.doesNotMatch(html, /target="_blank"/u);
});

test("keeps real auto-linked urls as browser links", () => {
  const html = renderMarkdown("example.com");

  assert.match(html, /href="http:\/\/example\.com"/u);
  assert.match(html, /target="_blank"/u);
});

test("resolves PowerPoint links from messages for workspace preview", () => {
  const href = "deliverables/enterprise-token-test-plan.pptx";
  const html = renderMarkdown(`[企业 Token 测试方案](${href})`);

  assert.match(html, /href="deliverables\/enterprise-token-test-plan\.pptx"/u);
  assert.doesNotMatch(html, /target="_blank"/u);
  assert.equal(resolveMarkdownWorkspaceLinkPath(href), href);
});

test("keeps explicit windows absolute markdown links for workspace preview", () => {
  const absoluteHref = "D:/cf/codeflow-docs/文档知识库/产品功能/定时任务流程实例调度策略/需求分析/定时任务流程实例调度策略方案.md";
  const relativePath = "codeflow-docs/文档知识库/产品功能/定时任务流程实例调度策略/需求分析/定时任务流程实例调度策略方案.md";
  const html = renderMarkdown(`[定时任务流程实例调度策略方案.md](${absoluteHref})`);
  const encodedHref = encodeURI(absoluteHref);

  assert.match(html, new RegExp(`href="${encodedHref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.doesNotMatch(html, /href="定时任务流程实例调度策略方案\.md"/u);
  assert.doesNotMatch(html, /target="_blank"/u);
  assert.equal(resolveMarkdownWorkspaceLinkPath(encodedHref, null, "D:/cf"), relativePath);
});

test("resolves windows absolute markdown links with line suffix", () => {
  const absoluteHref = "D:/cf/codeflow-docs/知识库/示例文档.md:115";
  const relativePath = "codeflow-docs/知识库/示例文档.md";
  const html = renderMarkdown(`[示例文档.md](${absoluteHref})`);
  const encodedHref = encodeURI(absoluteHref);

  assert.match(html, new RegExp(`href="${encodedHref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.doesNotMatch(html, /href="示例文档\.md"/u);
  assert.equal(resolveMarkdownWorkspaceLinkPath(encodedHref, null, "D:/cf"), relativePath);
  assert.equal(stripWorkspaceFileLineSuffix("D:/cf/a/b/readme.md:115:7"), "D:/cf/a/b/readme.md");
});

test("resolves markdown resource paths relative to the markdown file", () => {
  assert.equal(resolveMarkdownResourcePath("docs/a/readme.md", "../img/x.png"), "docs/img/x.png");
  assert.equal(resolveMarkdownResourcePath("readme.md", "./img/x.png?raw#top"), "img/x.png");
  assert.equal(resolveMarkdownResourcePath("docs/readme.md", "../../secret.png"), null);
});

test("resolves markdown workspace file links and keeps browser-only links untouched", () => {
  assert.equal(resolveMarkdownWorkspaceLinkPath("报表模型设计.md"), "报表模型设计.md");
  assert.equal(resolveMarkdownWorkspaceLinkPath("./assets/report%20draft.pdf#page=1"), "assets/report draft.pdf");
  assert.equal(resolveMarkdownWorkspaceLinkPath("../appendix.xlsx", "docs/spec/readme.md"), "docs/appendix.xlsx");
  assert.equal(resolveMarkdownWorkspaceLinkPath("https://example.com/report.md"), null);
  assert.equal(resolveMarkdownWorkspaceLinkPath("#章节"), null);
  assert.equal(resolveMarkdownWorkspaceLinkPath("/chat"), null);
  assert.throws(() => resolveMarkdownWorkspaceLinkPath("../secret.md"), /超出工作区/u);
  assert.throws(() => resolveMarkdownWorkspaceLinkPath("%E0%A4%A.md"), /文档链接编码无效/u);
});

test("明确文件引用不受后缀白名单限制，脚本和配置文件均可进入文本预览", () => {
  for (const ext of ["prc", "pck", "pkb", "pks", "ctl", "sas", "groovy", "gradle", "properties", "conf", "ini", "cfg", "自定义后缀"]) {
    const filePath = `source/脚本.${ext}`;
    for (const href of [filePath, `D:/project/${filePath}`, `/D:/project/${filePath}`]) {
      const encodedHref = encodeURI(`${href}:52:7`);
      const html = renderMarkdown(`[分类及入表条件](<${encodedHref}>)`);
      assert.match(html, /<a href=/u, href);
      assert.doesNotMatch(html, /target="_blank"/u, href);
      assert.equal(resolveMarkdownWorkspaceLinkPath(encodedHref, null, "D:/project"), filePath);
    }
    assert.equal(detectPreviewType({ path: filePath, content: "select 1;", isBinary: false, size: 9 }), "code");
  }
});

test("兼容 Windows 大小写、编码行号、共享 Host 路径缺失和无后缀脚本", () => {
  assert.equal(resolveMarkdownWorkspaceLinkPath("/d:/PROJECT/source/a.prc%3A52%3A7", null, "D:/project/"), "source/a.prc");
  assert.equal(resolveMarkdownWorkspaceLinkPath("/D:/project/source/a.pck:52"), "D:/project/source/a.pck");
  assert.equal(resolveMarkdownWorkspaceLinkPath("D:/project/source/a.pck:52", null, "共享项目"), "D:/project/source/a.pck");
  assert.equal(resolveMarkdownWorkspaceLinkPath("/D:/source/a.prc:52", null, "d:/"), "source/a.prc");
  assert.equal(resolveMarkdownWorkspaceLinkPath("/home/project/source/a.pck:52", null, "/home/project"), "source/a.pck");
  assert.equal(resolveMarkdownWorkspaceLinkPath("/source/a.pck:52", null, "/"), "source/a.pck");
  for (const href of ["D:%5Cproject%5Csource%5Ca.prc:52", "D:%2Fproject%2Fsource%2Fa.pck:52"]) {
    assert.match(renderMarkdown(`[脚本](${href})`), /<a href=/u);
    assert.equal(resolveMarkdownWorkspaceLinkPath(href, null, "D:/project"), href.includes("prc") ? "source/a.prc" : "source/a.pck");
  }
  assert.equal(resolveMarkdownWorkspaceLinkPath("./Dockerfile:52"), "Dockerfile");
  assert.equal(resolveMarkdownWorkspaceLinkPath("scripts/deploy:52"), "scripts/deploy");
  assert.equal(resolveMarkdownWorkspaceLinkPath("D:/project/Makefile:52", null, "D:/project"), "Makefile");
  assert.match(renderMarkdown("[构建文件](D:/project/Makefile:52)"), /<a href=/u);
  assert.equal(stripWorkspaceFileLineSuffix("D:/project/Makefile:52:7"), "D:/project/Makefile");
});

test("真实网址和应用路由保持浏览器行为，文件越界及非法编码显式失败", () => {
  for (const domain of ["example.com", "example.org", "example.net", "example.io"]) {
    const html = renderMarkdown(domain);
    assert.match(html, new RegExp(`href="http://${domain.replaceAll(".", "\\.")}"`, "u"));
    assert.match(html, /target="_blank"/u);
  }
  for (const href of ["https://example.com/a.prc", "http://example.com/a.pck", "//example.com/a.conf", "mailto:test@example.com", "#章节", "/chat", "/orchestration/workspace", "/auth/login"]) {
    assert.equal(resolveMarkdownWorkspaceLinkPath(href, null, "D:/project"), null);
  }
  for (const href of ["../secret.prc", "%2e%2e/secret.pck", "D:/project/../secret.prc", "/D:/other/a.pck", "D:/project-other/a.prc", "E:/project/a.pck"]) {
    assert.throws(() => resolveMarkdownWorkspaceLinkPath(href, null, "D:/project"), /工作区/u, href);
  }
  assert.throws(() => resolveMarkdownWorkspaceLinkPath("source/%E0%A4%A.prc"), /编码无效/u);
  assert.throws(() => resolveMarkdownWorkspaceLinkPath("source/%00a.prc"), /无效字符/u);
  assert.equal(detectPreviewType({ path: "archive.zip", content: null, isBinary: true, size: 9 }), "binary");
});

test("无后缀文件的显式相对引用进入预览，不依赖文件名白名单或 ./ 前缀", () => {
  for (const fileName of ["Dockerfile", "README", "Makefile", "LICENSE", "bootstrap"]) {
    assert.match(renderMarkdown(`[文本文件](${fileName})`), /<a href=/u);
    assert.equal(resolveMarkdownWorkspaceLinkPath(fileName), fileName);
    assert.equal(resolveMarkdownWorkspaceLinkPath(fileName, "docs/readme.md"), `docs/${fileName}`);
  }
  assert.equal(resolveMarkdownWorkspaceLinkPath("/chat"), null);
  assert.equal(resolveMarkdownWorkspaceLinkPath("/auth/login"), null);
});

test("编码文件名中的 #/? 和尾部行列号分别解析，真实锚点和查询参数仍被移除", () => {
  for (const [encodedName, decodedName] of [["report%23final.md", "report#final.md"], ["report%3Ffinal.md", "report?final.md"]]) {
    for (const suffix of ["", ":52", ":52:7", "%3A52%3A7"]) {
      for (const prefix of ["", "D:/project/", "/D:/project/"]) {
        const href = `${prefix}${encodedName}${suffix}?raw=1#section`;
        assert.match(renderMarkdown(`[文档](${href})`), /<a href=/u);
        assert.equal(resolveMarkdownWorkspaceLinkPath(href, null, "D:/project"), decodedName, href);
      }
    }
  }
  assert.equal(resolveMarkdownWorkspaceLinkPath("%23report.md:52"), "#report.md");
  assert.equal(resolveMarkdownWorkspaceLinkPath("#section"), null);
  assert.equal(stripWorkspaceFileLineSuffix("D:/project/report#final.md:52:7"), "D:/project/report#final.md");
});
