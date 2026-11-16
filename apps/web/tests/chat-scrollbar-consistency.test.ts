import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const layoutSource = read("../src/styles/layout.css");
const chatPanelStyles = read("../src/styles/chat-panel.css");
const chatPanelSource = read("../src/features/chat/components/chat-panel.vue");
const tokensSource = read("../src/styles/tokens.css");

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(vue|css)$/u.test(entry.name) ? [full] : [];
  });
}

/** 收集样式文本：.css 取全文，.vue 只取 <style> 块，并去掉块注释（注释里的示例不算规则）。 */
function listStyleSources(): Array<{ file: string; css: string }> {
  const entries: Array<{ file: string; css: string }> = [];
  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const file of listSourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    if (file.endsWith(".css")) {
      entries.push({ file, css: stripComments(source) });
      continue;
    }
    for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)) {
      entries.push({ file, css: stripComments(block[1] ?? "") });
    }
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 滚动条改走全局兜底：一处规则覆盖所有滚动盒，不再逐个枚举容器。 */
test("滚动条由全局规则统一，且不再维护容器枚举表", () => {
  assert.match(layoutSource, /:root\s*\{[^}]*scrollbar-color:\s*var\(--app-scrollbar-thumb\)\s*transparent;/su);
  assert.match(layoutSource, /\*\s*\{[^}]*scrollbar-width:\s*thin;/su);
  for (const token of ["--app-scrollbar-size", "--app-scrollbar-thumb", "--app-scrollbar-thumb-hover"]) {
    assert.ok(layoutSource.includes(`var(${token})`), `全局滚动条规则未使用 ${token}`);
  }
  // 枚举表退役：容器不再逐个进列表，新增页面无需再登记。
  assert.doesNotMatch(layoutSource, /\.role-list__items,/u, "不应再出现逐容器枚举的选择器列表");
});

/**
 * 全局声明 scrollbar-width 后，::-webkit-scrollbar 的样式会被忽略（现代 Chromium）。
 * 因此「隐藏滚动条」必须同时写标准属性，否则隐藏失效、重新露出滚动条。
 */
test("隐藏滚动条的地方都同时声明了 scrollbar-width: none", () => {
  const offenders: string[] = [];
  for (const { file, css } of listStyleSources()) {
    for (const match of css.matchAll(/([^\n{}]+)::-webkit-scrollbar\s*\{([^}]*)\}/gu)) {
      if (!/display:\s*none/u.test(match[2] ?? "")) continue;
      const selector = (match[1] ?? "").trim();
      const standardProperty = new RegExp(
        `${escapeRegExp(selector)}\\s*\\{[^}]*scrollbar-width:\\s*none`,
        "su",
      );
      if (!standardProperty.test(css)) {
        offenders.push(`${path.relative(srcRoot, file)}: ${selector}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "这些地方只写了 webkit 隐藏，会在全局 scrollbar-width 下重新露出滚动条");
});

test("会话消息区不再保留自己的滚动条规则，H5 两条屏蔽规则都在", () => {
  assert.doesNotMatch(chatPanelStyles, /chat-panel__messages::-webkit-scrollbar/u, "chat-panel.css 会因导入更晚顶掉统一组");
  // H5 的两条分工不同：标准属性负责现代 Chromium，webkit 规则只兜底老引擎，缺一会重新露出滚动条。
  assert.match(chatPanelSource, /\.chat-panel--h5 \.chat-panel__messages\s*\{[^}]*scrollbar-width:\s*none;/su);
  assert.match(chatPanelSource, /\.chat-panel--h5 \.chat-panel__messages::-webkit-scrollbar\s*\{\s*display:\s*none;/su);
});

test("滚动条 token 只在亮色 :root 声明一次且颜色随 --app-muted 自适应", () => {
  const rootBlock = tokensSource.slice(tokensSource.indexOf(":root {"), tokensSource.indexOf("/* 暗色主题"));
  for (const token of ["--app-scrollbar-size", "--app-scrollbar-thumb", "--app-scrollbar-thumb-hover"]) {
    // 全文件仅 1 次声明，同时排除两个暗色块里的重复声明（color-mix 在暗色下按新 --app-muted 求值）。
    assert.equal(tokensSource.split(`${token}:`).length - 1, 1, `${token} 应只在亮色 :root 声明一次`);
    assert.match(rootBlock, new RegExp(`${token}:`, "u"));
  }
  assert.match(tokensSource, /--app-scrollbar-thumb:\s*color-mix\(in srgb, var\(--app-muted\) 28%,\s*transparent\)/u);
});
