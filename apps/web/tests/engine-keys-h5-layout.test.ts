import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panelSource = fs.readFileSync("apps/web/src/features/settings/components/engine-keys-panel.vue", "utf8");

/** 截取某条规则的声明块；选择器未命中时返回空串。 */
function ruleBody(selector: string): string {
  const start = panelSource.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = panelSource.indexOf("}", start);
  return end < 0 ? "" : panelSource.slice(start, end);
}

test("H5 密钥面板把容器改为 flex column 后必须显式 stretch 交叉轴", () => {
  // 基础样式的 align-items: start / flex-start 在 grid 里作用于块轴，改成 flex column 后会
  // 转到水平轴，漏配 stretch 会让 detail 与卡片收缩到内容宽度（卡片不铺满、动作按钮被迫换行）。
  // 同文件的 @media (max-width: 720px) 对 .ek-panel__item 已用 stretch 规避，这里锁定 H5 路径。
  for (const selector of [".ek-panel--h5 .ek-panel__layout", ".ek-panel--h5 .ek-panel__item"]) {
    const body = ruleBody(selector);
    assert.notEqual(body, "", `${selector} 规则必须存在`);
    assert.match(body, /flex-direction: column/u);
    assert.match(body, /align-items: stretch/u);
  }
});
