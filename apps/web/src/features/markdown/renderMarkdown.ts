import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import { hasKnownWorkspaceFileExtension, resolveMarkdownWorkspaceLinkPath, stripWorkspaceFileLineSuffix } from "./markdownWorkspaceLinks";

export interface TocHeading {
  level: number;
  text: string;
  slug: string;
}

export type MarkdownRenderOptions = {
  /** 是否把相对图片标记为工作区资源，供组件异步读取并替换为 data URL。 */
  resolveLocalImages?: boolean;
};

type MarkdownRenderEnv = {
  resolveLocalImages?: boolean;
};

const ALLOWED_HTML_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "wbr",
]);
const VOID_HTML_TAGS = new Set(["br", "hr", "img", "wbr"]);
const GLOBAL_HTML_ATTRS = new Set(["aria-hidden", "aria-label", "class", "title"]);
const HTML_TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "target", "title"]),
  details: new Set(["open"]),
  img: new Set(["alt", "decoding", "height", "loading", "src", "title", "width"]),
  td: new Set(["align", "colspan", "rowspan"]),
  th: new Set(["align", "colspan", "rowspan"]),
};
const BOOLEAN_HTML_ATTRS = new Set(["open"]);
const ATTR_PATTERN = /([:@A-Za-z_][:@A-Za-z0-9_.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
type SanitizedHtmlAttrs = {
  attrs: string;
  blockedImageReason: string | null;
};

/** 生成 heading slug：小写、保留中文、空格转连字符、去除特殊字符、同名去重。 */
export function generateSlug(text: string, slugCount: Map<string, number>): string {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
  if (!slug) slug = "heading";
  const count = slugCount.get(slug) ?? 0;
  slugCount.set(slug, count + 1);
  return count > 0 ? `${slug}-${count}` : slug;
}

/** 从 inline token children 中提取纯文本。 */
function getHeadingText(inlineToken: { children: Array<{ type: string; content: string }> | null } | undefined): string {
  return inlineToken?.children
    ?.filter((t) => t.type === "text" || t.type === "code_inline")
    .map((t) => t.content)
    .join("") ?? "";
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
});

// ── heading_open：为每个标题添加 id 属性，用于 TOC 跳转 ──
const slugCount = new Map<string, number>();
md.renderer.rules.heading_open = function (tokens, idx, options, _env, self) {
  const token = tokens[idx]!;
  const text = getHeadingText(tokens[idx + 1]);
  const slug = generateSlug(text, slugCount);
  token.attrSet("id", slug);
  return self.renderToken(tokens, idx, options);
};

// 允许常见安全链接和图片资源协议，具体 a/img 渲染阶段会再次按标签收紧。
md.validateLink = (url: string) => {
  const u = String(url ?? "").trim();
  if (!u) return false;
  return isSafeMarkdownLinkHref(u) || isSafeMarkdownImageSrc(u);
};

// 外部网站链接默认新窗口打开，避免把当前应用页面直接跳走。
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  const autoLinkedWorkspacePath = resolveAutoLinkedWorkspaceFilePath(tokens, idx, token.attrGet("href"));
  if (autoLinkedWorkspacePath) token.attrSet("href", autoLinkedWorkspacePath);

  const href = String(token.attrGet("href") ?? "").trim();
  if (!isSafeMarkdownLinkHref(href)) {
    token.attrSet("href", "#");
    token.attrSet("aria-disabled", "true");
    token.attrJoin("class", "markdown-link--blocked");
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  if (/^https?:\/\//i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** 将 linkify 误识别为域名的裸文件名还原为工作区相对文件链接。 */
function resolveAutoLinkedWorkspaceFilePath(
  tokens: Array<{ type: string; content: string; markup: string; info: string }>,
  idx: number,
  rawHref: string | null,
): string | null {
  const token = tokens[idx];
  const href = String(rawHref ?? "").trim();
  if (!token || token.markup !== "linkify" || token.info !== "auto" || !/^https?:\/\//iu.test(href)) return null;

  const text = readSingleTextLinkContent(tokens, idx);
  if (!text || /^[a-z][a-z0-9+.-]*:/iu.test(text) || /^www\./iu.test(text)) return null;
  if (!hasKnownWorkspaceFileExtension(text)) return null;
  return resolveMarkdownWorkspaceLinkPath(text);
}

/** 读取自动链接内部的纯文本；包含复杂 inline token 时不做文件链接推断。 */
function readSingleTextLinkContent(
  tokens: Array<{ type: string; content: string; markup: string }>,
  idx: number,
): string | null {
  const parts: string[] = [];
  for (let i = idx + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) return null;
    if (token.type === "link_close" && token.markup === "linkify") {
      const text = parts.join("").trim();
      return text || null;
    }
    if (token.type !== "text") return null;
    parts.push(token.content);
  }
  return null;
}

/** 渲染图片 token，支持远程/data/工作区相对图片并补齐懒加载属性。 */
md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  const src = String(token.attrGet("src") ?? "").trim();
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  if (!isSafeMarkdownImageSrc(src)) {
    return `<span class="markdown-image-error">图片地址不安全，已阻止渲染</span>`;
  }

  token.attrSet("alt", alt);
  token.attrSet("loading", token.attrGet("loading") ?? "lazy");
  token.attrSet("decoding", token.attrGet("decoding") ?? "async");
  token.attrJoin("class", "markdown-image");

  if (shouldResolveLocalImage(src, readMarkdownRenderEnv(env))) {
    token.attrSet("src", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E");
    token.attrSet("data-markdown-resource", "image");
    token.attrSet("data-markdown-src", src);
    token.attrJoin("class", "markdown-image--loading");
  }

  return self.renderToken(tokens, idx, options);
};

/** 安全渲染 Markdown 内的原始 HTML，只保留文档预览常用的低风险标签和属性。 */
md.renderer.rules.html_block = function (tokens, idx, _options, env) {
  return sanitizeAllowedHtml(tokens[idx]?.content ?? "", readMarkdownRenderEnv(env));
};

/** 安全渲染 Markdown 行内 HTML，和 block HTML 使用同一白名单。 */
md.renderer.rules.html_inline = function (tokens, idx, _options, env) {
  return sanitizeAllowedHtml(tokens[idx]?.content ?? "", readMarkdownRenderEnv(env));
};

/**
 * 自定义 fence 渲染：代码块 + highlight.js 语法高亮 + 复制按钮 header。
 * 输出结构：
 *   <div class="code-block">
 *     <div class="code-block__header">
 *       <span class="code-block__lang">javascript</span>
 *       <button class="code-block__copy">复制</button>
 *     </div>
 *     <pre><code class="language-js">...highlighted...</code></pre>
 *   </div>
 */
md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx]!;
  const info = (token.info ?? "").trim();
  const langName = info.split(/\s+/g)[0] ?? "";
  const langLabel = langName || "text";
  const content = token.content;

  // ── mermaid 代码块：输出占位 HTML，由 useMermaid composable 异步渲染为 SVG ──
  if (langName === "mermaid") {
    const escapedSource = md.utils.escapeHtml(content);
    return (
      `<div class="mermaid-block mermaid-pending">` +
      `<div class="mermaid-block__header">` +
      `<span class="mermaid-block__lang">mermaid</span>` +
      `</div>` +
      `<pre class="mermaid-source">${escapedSource}</pre>` +
      `</div>\n`
    );
  }

  let highlighted: string;
  if (langName && hljs.getLanguage(langName)) {
    try {
      highlighted = hljs.highlight(content, { language: langName, ignoreIllegals: true }).value;
    } catch {
      highlighted = md.utils.escapeHtml(content);
    }
  } else {
    highlighted = md.utils.escapeHtml(content);
  }

  const escapedLang = md.utils.escapeHtml(langLabel);
  const langClass = langName ? `language-${md.utils.escapeHtml(langName)}` : "";
  return (
    `<div class="code-block">` +
    `<div class="code-block__header">` +
    `<span class="code-block__lang">${escapedLang}</span>` +
    `<button type="button" class="code-block__copy">复制</button>` +
    `</div>` +
    `<pre><code class="${langClass}">${highlighted}</code></pre>` +
    `</div>\n`
  );
};

/** 解析 markdown 文本，提取标题列表用于 TOC 大纲。 */
export function extractTocHeadings(text: string): TocHeading[] {
  const tokens = md.parse(String(text ?? ""), {});
  const headings: TocHeading[] = [];
  const localSlugCount = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== "heading_open") continue;
    const level = parseInt(token.tag.slice(1), 10);
    if (level > 4) continue;
    const headingText = getHeadingText(tokens[i + 1]);
    const slug = generateSlug(headingText, localSlugCount);
    headings.push({ level, text: headingText, slug });
  }
  return headings;
}

/** 展示时移除与独立文章标题相同的首个 H1，保留数据库中的原始 Markdown。 */
export function stripMatchingFirstMarkdownH1(text: string, articleTitle: string): string {
  const source = String(text ?? "");
  const tokens = md.parse(source, {});
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== "heading_open" || token.tag !== "h1") continue;
    const headingText = getHeadingText(tokens[index + 1]);
    if (normalizeHeadingText(headingText) !== normalizeHeadingText(articleTitle)) return source;
    const [startLine, endLine] = token.map ?? [];
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return source;
    const lines = source.split(/\r?\n/u);
    lines.splice(startLine!, endLine! - startLine!);
    return lines.join(source.includes("\r\n") ? "\r\n" : "\n").replace(/^(?:[ \t]*\r?\n)+/u, "");
  }
  return source;
}

/** 归一化标题空白，仅用于判断 Markdown H1 是否与文章标题相同。 */
function normalizeHeadingText(value: string): string {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

/** 将消息文本渲染为安全的 Markdown HTML（白名单原始 HTML，启用语法高亮）。 */
export function renderMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  slugCount.clear();
  const env: MarkdownRenderEnv = { resolveLocalImages: options.resolveLocalImages === true };
  let html = md.render(String(text ?? ""), env);
  html = renderTaskList(html);
  // 移除 <ul>/<ol> 内 <li> 之间的空白文本节点，防止浏览器将 \n 渲染为额外行高间距。
  html = html.replace(/<\/li>\s+<li/g, "</li><li");
  html = html.replace(/<[uo]l>\s+<li/g, (m) => m.replace(/\s+/g, ""));
  html = html.replace(/<\/li>\s+<\/[uo]l>/g, (m) => m.replace(/\s+/g, ""));
  return html;
}

function renderTaskList(html: string): string {
  /** 将 `- [ ]` / `- [x]` 渲染为禁用 checkbox（GFM task list 的最小实现）。 */
  const unchecked = '<input type="checkbox" class="task-list-item-checkbox" disabled tabindex="-1" />';
  const checked = '<input type="checkbox" class="task-list-item-checkbox" disabled tabindex="-1" checked />';

  let out = String(html ?? "");
  out = out.replace(/<li>\s*\[ \]\s*/g, `<li class="task-list-item">${unchecked} `);
  out = out.replace(/<li>\s*\[(?:x|X)\]\s*/g, `<li class="task-list-item">${checked} `);
  out = out.replace(/<li>\s*<p>\s*\[ \]\s*/g, `<li class="task-list-item"><p>${unchecked} `);
  out = out.replace(/<li>\s*<p>\s*\[(?:x|X)\]\s*/g, `<li class="task-list-item"><p>${checked} `);
  return out;
}

/** 从 markdown-it 的 env 中读取本模块认可的渲染选项。 */
function readMarkdownRenderEnv(env: unknown): MarkdownRenderEnv {
  if (!env || typeof env !== "object") return {};
  const record = env as Record<string, unknown>;
  return { resolveLocalImages: record.resolveLocalImages === true };
}

/** 判断链接 href 是否可作为 a 标签目标。 */
function isSafeMarkdownLinkHref(url: string): boolean {
  const value = normalizeUrlForCheck(url);
  if (!value) return false;
  if (/^https?:\/\//iu.test(value) || /^mailto:/iu.test(value)) return true;
  if (value.startsWith("#")) return true;
  if (isSafeLocalAbsoluteFileHref(value)) return true;
  return isSafeRelativeUrl(value);
}

/** 判断图片 src 是否可渲染；图片额外允许 data:image。 */
function isSafeMarkdownImageSrc(url: string): boolean {
  const value = normalizeUrlForCheck(url);
  if (!value) return false;
  if (/^https?:\/\//iu.test(value)) return true;
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/iu.test(value)) return true;
  if (value.startsWith("#")) return false;
  return isSafeRelativeUrl(value);
}

/** 统一 URL 检查输入，拒绝控制字符和空白边界。 */
function normalizeUrlForCheck(url: string): string {
  const value = String(url ?? "").trim();
  return /[\u0000-\u001f\u007f]/u.test(value) ? "" : value;
}

/** 允许 Windows 本地绝对文件路径保留为 href，由点击层再校验是否属于工作区。 */
function isSafeLocalAbsoluteFileHref(url: string): boolean {
  const pathOnly = stripWorkspaceFileLineSuffix(stripUrlQueryAndHash(url).replace(/%2f|%5c/giu, "/"));
  if (!/^[a-z]:[\\/]/iu.test(pathOnly)) return false;
  if (/[<>"|*]/u.test(pathOnly)) return false;
  return /[/\\][^/\\:]+$/u.test(pathOnly);
}

/** 移除查询参数和锚点，文件类型判断只看路径本体。 */
function stripUrlQueryAndHash(url: string): string {
  const index = url.search(/[?#]/u);
  return index >= 0 ? url.slice(0, index) : url;
}

/** 判断 URL 是否是不含协议的相对路径或根路径。 */
function isSafeRelativeUrl(url: string): boolean {
  if (!url || url.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(url)) return false;
  return !/[<>\\]/u.test(url);
}

/** 判断图片是否需要交给组件按当前 Markdown 文件路径解析。 */
function shouldResolveLocalImage(src: string, env: MarkdownRenderEnv): boolean {
  if (env.resolveLocalImages !== true) return false;
  const value = normalizeUrlForCheck(src);
  if (!value) return false;
  if (/^(?:https?:|data:image\/)/iu.test(value)) return false;
  return isSafeRelativeUrl(value);
}

/** 对 Markdown 内 HTML 做白名单过滤，避免 v-html 注入脚本或事件属性。 */
function sanitizeAllowedHtml(html: string, env: MarkdownRenderEnv): string {
  const source = String(html ?? "");
  return source
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<\/?([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?\/?>/gu, (raw, rawTag: string, rawAttrs: string | undefined) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_HTML_TAGS.has(tag)) return md.utils.escapeHtml(raw);
      const closing = /^<\s*\//u.test(raw);
      if (closing) return VOID_HTML_TAGS.has(tag) ? "" : `</${tag}>`;
      const selfClosing = /\/\s*>$/u.test(raw) || VOID_HTML_TAGS.has(tag);
      const result = sanitizeHtmlAttrs(tag, rawAttrs ?? "", env);
      if (result.blockedImageReason) return `<span class="markdown-image-error">${md.utils.escapeHtml(result.blockedImageReason)}</span>`;
      return `<${tag}${result.attrs}${selfClosing ? " />" : ">"}`;
    });
}

/** 清洗单个 HTML 标签属性，只保留当前标签支持的安全属性。 */
function sanitizeHtmlAttrs(tag: string, rawAttrs: string, env: MarkdownRenderEnv): SanitizedHtmlAttrs {
  const allowedAttrs = HTML_TAG_ATTRS[tag] ?? new Set<string>();
  const attrs: string[] = [];
  const attrNames = new Set<string>();
  let classValue = "";
  let rawImgSrc: string | null = null;
  let blockedImageReason: string | null = tag === "img" ? "图片地址缺失，无法渲染" : null;
  let anchorTarget: string | null = null;
  let anchorRel: string | null = null;
  for (const match of rawAttrs.matchAll(ATTR_PATTERN)) {
    const name = String(match[1] ?? "").toLowerCase();
    if (name.startsWith("on") || name === "style") continue;
    if (!GLOBAL_HTML_ATTRS.has(name) && !allowedAttrs.has(name)) continue;

    const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
    const value = String(rawValue);
    if (tag === "img" && name === "src") {
      rawImgSrc = value;
      blockedImageReason = "图片地址不安全，已阻止渲染";
    }
    const normalized = sanitizeHtmlAttrValue(tag, name, value, env);
    if (normalized == null) continue;
    attrNames.add(name);
    if (tag === "img" && name === "src") blockedImageReason = null;
    if (name === "class") {
      classValue = normalized;
      continue;
    }
    if (tag === "a" && name === "target") anchorTarget = normalized;
    if (tag === "a" && name === "rel") {
      anchorRel = normalized;
      continue;
    }
    if (BOOLEAN_HTML_ATTRS.has(name)) {
      attrs.push(name);
      continue;
    }
    attrs.push(`${name}="${md.utils.escapeHtml(normalized)}"`);
  }
  if (tag === "a" && (anchorRel != null || anchorTarget === "_blank")) {
    const rel = anchorTarget === "_blank" ? mergeSpaceTokens(anchorRel ?? "", "noopener noreferrer") : (anchorRel ?? "");
    if (rel) attrs.push(`rel="${md.utils.escapeHtml(rel)}"`);
  }
  if (tag === "img") {
    if (blockedImageReason) return { attrs: "", blockedImageReason };
    if (!attrNames.has("loading")) attrs.push(`loading="lazy"`);
    if (!attrNames.has("decoding")) attrs.push(`decoding="async"`);
    if (rawImgSrc && shouldResolveLocalImage(rawImgSrc, env)) {
      attrs.push(`data-markdown-resource="image"`);
      attrs.push(`data-markdown-src="${md.utils.escapeHtml(rawImgSrc)}"`);
      classValue = mergeClassNames(classValue, "markdown-image markdown-image--loading");
    } else {
      classValue = mergeClassNames(classValue, "markdown-image");
    }
  }
  if (classValue) attrs.push(`class="${md.utils.escapeHtml(classValue)}"`);
  return { attrs: attrs.length ? ` ${attrs.join(" ")}` : "", blockedImageReason: null };
}

/** 按标签语义校验属性值，并为本地图片补工作区资源标记。 */
function sanitizeHtmlAttrValue(tag: string, name: string, value: string, env: MarkdownRenderEnv): string | null {
  if (name === "class") return value.replace(/[^\w\s-]/gu, " ").trim();
  if (name === "href") return isSafeMarkdownLinkHref(value) ? value : null;
  if (name === "target") return value === "_blank" || value === "_self" ? value : null;
  if (name === "rel") return value.replace(/[^\w\s-]/gu, "").trim();
  if (tag === "img" && name === "src") {
    if (!isSafeMarkdownImageSrc(value)) return null;
    return shouldResolveLocalImage(value, env)
      ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E"
      : value;
  }
  if (tag === "img" && (name === "width" || name === "height")) {
    return /^\d{1,5}$/u.test(value.trim()) ? value.trim() : null;
  }
  if ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) {
    return /^\d{1,2}$/u.test(value.trim()) ? value.trim() : null;
  }
  if ((tag === "td" || tag === "th") && name === "align") {
    const normalized = value.trim().toLowerCase();
    return ["center", "left", "right"].includes(normalized) ? normalized : null;
  }
  if (BOOLEAN_HTML_ATTRS.has(name)) return "";
  return value;
}

/** 合并 HTML class，去重后保持稳定输出。 */
function mergeClassNames(left: string, right: string): string {
  return mergeSpaceTokens(left, right);
}

/** 合并空格分隔 token，去重后保持稳定输出。 */
function mergeSpaceTokens(left: string, right: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of `${left} ${right}`.split(/\s+/gu)) {
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.join(" ");
}
