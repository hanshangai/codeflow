import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/** 设置/管理后台所有表格统一表头与单元格居中。 */
test("admin tables center header and body text in both axes", () => {
  const css = fs.readFileSync(new URL("../src/features/admin/styles/admin-table.css", import.meta.url), "utf8");
  assert.match(css, /\.admin-layout__content \.ant-table-thead > tr > th[\s\S]*?text-align: center !important;[\s\S]*?vertical-align: middle !important;/u);
  assert.match(css, /\.admin-layout__content \.ant-table-tbody > tr > td[\s\S]*?text-align: center !important;[\s\S]*?vertical-align: middle !important;/u);
});
