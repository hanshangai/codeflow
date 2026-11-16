import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  defaultCodeflowaiConfig,
  ensureCodeflowaiConfig,
  readExistingCodeflowaiConfig,
  resolveKnowledgeAssetsRoot,
  workflowDocsRootMigration,
  writeCodeflowaiConfig,
} from "../src/codeflowai/codeflowaiConfig.ts";

const PRIVATE_ROOTS = [".codeflowai", ".codeflowai/docs", ".CODEFLOW/docs", ".codeflow\\docs", "./.codeflowai/docs"];
const DOCUMENT = "# 正式知识\n保留原项目正文。\n";
const RUNTIME = Buffer.from([0, 1, 2, 128, 255]);
const DOCUMENT_PATH = "codeflow-docs/规格知识库/正文.md";
const RUNTIME_PATH = ".codeflowai/runtime.bin";
const CONFIG_PATH = ".codeflowai/codeflowai.json";
const MIGRATION_PATH = ".codeflowai/docs-root-migration.json";

/** 每个场景使用独占真实工作区，结束时仅清理该临时目录。 */
function workspace(t: TestContext): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-private-docs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 建立真实文件夹和字节内容，不依赖知识 Store 或数据库。 */
function put(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

/** 只改变文档根，沿用现有配置接口的其他合法字段。 */
function configFor(workflowDocsRoot: string) {
  return { ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot } };
}

/** 同时记录空目录与文件字节，检测拒绝操作中的额外写入或移动。 */
function snapshot(root: string, relative = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const entry = path.join(relative, name);
    if (fs.statSync(path.join(root, entry)).isDirectory()) {
      result[`${entry}/`] = "";
      Object.assign(result, snapshot(root, entry));
    } else {
      result[entry] = fs.readFileSync(path.join(root, entry)).toString("hex");
    }
  }
  return result;
}

/** 非法根须在配置替换、目录移动或迁移记录删除之前显式失败。 */
function assertRejectedWithoutWrites(root: string, operation: () => unknown, context: string): void {
  const before = snapshot(root);
  assert.throws(operation, /控制目录/, context);
  assert.deepEqual(snapshot(root), before, context);
}

/** 保留正式正文、原配置和私有运行文件，供迁移拒绝与成功场景共用。 */
function existingWorkspace(t: TestContext): string {
  const root = workspace(t);
  ensureCodeflowaiConfig(root);
  put(root, DOCUMENT_PATH, DOCUMENT);
  put(root, RUNTIME_PATH, RUNTIME);
  return root;
}

/** 模拟目录已移到记录终点，暴露非法记录恢复时的 rename 或记录删除。 */
function pendingWorkspace(t: TestContext, side: "from" | "to", privateRoot: string): string {
  const root = workspace(t);
  ensureCodeflowaiConfig(root);
  put(root, RUNTIME_PATH, RUNTIME);
  const from = path.join(root, side === "from" ? privateRoot : "codeflow-docs");
  const to = path.join(root, side === "to" ? privateRoot : "codeflow-docs");
  put(root, path.join(path.relative(root, to), "规格知识库/正文.md"), DOCUMENT);
  put(root, MIGRATION_PATH, JSON.stringify({ from, to }));
  return root;
}

test("新项目拒绝私有运行目录及其后代，且不创建配置或文档", t => {
  for (const privateRoot of PRIVATE_ROOTS) {
    const root = workspace(t);
    assertRejectedWithoutWrites(root, () => writeCodeflowaiConfig(root, configFor(privateRoot)), privateRoot);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("已有项目拒绝把文档迁入私有运行目录，原配置、正文和运行字节不变", t => {
  const root = existingWorkspace(t);
  for (const privateRoot of PRIVATE_ROOTS) {
    assertRejectedWithoutWrites(root, () => writeCodeflowaiConfig(root, configFor(privateRoot)), privateRoot);
  }
});

test("外部私有文档根在读取、确保配置和知识定位时显式失败且不重写文件", t => {
  const root = existingWorkspace(t);
  for (const privateRoot of PRIVATE_ROOTS) {
    put(root, CONFIG_PATH, JSON.stringify(configFor(privateRoot), null, 2));
    assertRejectedWithoutWrites(root, () => readExistingCodeflowaiConfig(root), `read: ${privateRoot}`);
    assertRejectedWithoutWrites(root, () => ensureCodeflowaiConfig(root), `ensure: ${privateRoot}`);
    assertRejectedWithoutWrites(root, () => resolveKnowledgeAssetsRoot(root), `knowledge: ${privateRoot}`);
  }
});

test("文档迁移预览拒绝私有运行目录目标且不改项目文件", t => {
  const root = existingWorkspace(t);
  for (const privateRoot of PRIVATE_ROOTS) {
    assertRejectedWithoutWrites(root, () => workflowDocsRootMigration(root, configFor(privateRoot)), privateRoot);
  }
});

test("未完成记录读取拒绝私有运行目录起止路径并保留全部字节", t => {
  for (const side of ["from", "to"] as const) {
    for (const privateRoot of [".codeflowai/docs", ".codeflowai", ".CODEFLOW/docs"]) {
      const root = pendingWorkspace(t, side, privateRoot);
      assertRejectedWithoutWrites(root, () => workflowDocsRootMigration(root, defaultCodeflowaiConfig()), `${side}: ${privateRoot}`);
      assertRejectedWithoutWrites(root, () => resolveKnowledgeAssetsRoot(root), `knowledge ${side}: ${privateRoot}`);
    }
  }
});

test("重试保存拒绝非法迁移记录，不挪动私有目录或删除记录", t => {
  for (const side of ["to", "from"] as const) {
    for (const privateRoot of [".codeflowai/docs", ".codeflowai", ".CODEFLOW/docs"]) {
      const root = pendingWorkspace(t, side, privateRoot);
      assertRejectedWithoutWrites(root, () => writeCodeflowaiConfig(root, defaultCodeflowaiConfig()), `${side}: ${privateRoot}`);
    }
  }
});

test("相近名称和普通嵌套文档根仍正常迁移，私有运行文件保持原位", t => {
  for (const [input, expected] of [[".codeflow-docs", ".codeflow-docs"], ["docs\\project", "docs/project"], ["docs/.codeflow", "docs/.codeflow"]] as const) {
    const root = existingWorkspace(t);
    assert.equal(writeCodeflowaiConfig(root, configFor(input)).config.paths!.workflowDocsRoot, expected);
    assert.equal(readExistingCodeflowaiConfig(root)!.config.paths!.workflowDocsRoot, expected);
    assert.equal(resolveKnowledgeAssetsRoot(root), `${expected}/规格知识库`);
    assert.equal(fs.readFileSync(path.join(root, expected, "规格知识库/正文.md"), "utf8"), DOCUMENT);
    assert.equal(fs.existsSync(path.join(root, "codeflow-docs")), false);
    assert.deepEqual(fs.readFileSync(path.join(root, RUNTIME_PATH)), RUNTIME);
    assert.equal(fs.existsSync(path.join(root, MIGRATION_PATH)), false);
  }
});

test("合法未完成迁移在配置切换前后均可恢复并保留正文及运行文件", t => {
  for (const committed of [false, true]) {
    const root = existingWorkspace(t);
    const from = path.join(root, "codeflow-docs");
    const to = path.join(root, "docs/project");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    put(root, MIGRATION_PATH, JSON.stringify({ from, to }));
    if (committed) put(root, CONFIG_PATH, JSON.stringify(configFor("docs/project"), null, 2));
    assert.equal(writeCodeflowaiConfig(root, configFor("docs/project")).config.paths!.workflowDocsRoot, "docs/project");
    assert.equal(resolveKnowledgeAssetsRoot(root), "docs/project/规格知识库");
    assert.equal(fs.readFileSync(path.join(to, "规格知识库/正文.md"), "utf8"), DOCUMENT);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.existsSync(path.join(root, MIGRATION_PATH)), false);
    assert.deepEqual(fs.readFileSync(path.join(root, RUNTIME_PATH)), RUNTIME);
  }
});
